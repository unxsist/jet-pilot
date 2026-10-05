//! The vault file, `vault/secrets.jpv`:
//!
//! ```text
//! {"format":"jpv","v":1,"key":{...},"nonce":"<base64>"}      <- header (plaintext JSON)
//! <base64 XChaCha20-Poly1305 ciphertext>
//! ```
//!
//! The ciphertext is `{"entries":{"<id>":{"value":<json>,"updatedAt":<unix s>}}}`
//! sealed with the 32-byte master key and the exact header line bytes as
//! associated data, so neither part can be changed without detection. Every
//! write uses a fresh random nonce.
//!
//! `key` says where the master key comes from:
//! - `{"type":"keychain","account":"vault-…"}`: an OS keychain item;
//! - `{"type":"passphrase","kdf":"argon2id","m":65536,"t":3,"p":1,"salt":"…","check":"…"}`:
//!   Argon2id of a passphrase (`m` in KiB). `check` is a key check value
//!   (truncated SHA-256 of the key) that tells a wrong passphrase apart from
//!   a damaged file.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const FORMAT: &str = "jpv";
pub const VERSION: u32 = 1;
const NONCE_LEN: usize = 24;
pub const SALT_LEN: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub format: String,
    pub v: u32,
    pub key: KeySpec,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KeySpec {
    Keychain {
        account: String,
    },
    Passphrase {
        kdf: String,
        m: u32,
        t: u32,
        p: u32,
        salt: String,
        check: String,
    },
}

impl KeySpec {
    /// The key check value a key must match, if the spec records one.
    pub fn check(&self) -> Option<&str> {
        match self {
            KeySpec::Passphrase { check, .. } => Some(check),
            KeySpec::Keychain { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Contents {
    #[serde(default)]
    pub entries: BTreeMap<String, StoredEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEntry {
    pub value: serde_json::Value,
    pub updated_at: i64,
}

/// The 32-byte master key; zeroed on drop, never printed.
#[derive(Clone)]
pub struct MasterKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

impl MasterKey {
    pub fn generate() -> MasterKey {
        let mut bytes = Zeroizing::new([0u8; 32]);
        crate::fsutil::fill_random(bytes.as_mut());
        MasterKey(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<MasterKey> {
        let array: [u8; 32] = bytes.try_into().ok()?;
        Some(MasterKey(Zeroizing::new(array)))
    }

    pub fn from_base64(text: &str) -> Option<MasterKey> {
        let bytes = Zeroizing::new(B64.decode(text.trim()).ok()?);
        MasterKey::from_bytes(&bytes)
    }

    pub fn to_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(B64.encode(self.0.as_ref()))
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_ref()
    }

    /// Truncated SHA-256 over a domain separator and the key.
    pub fn check_value(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"jet-pilot vault key check v1\0");
        hasher.update(self.0.as_ref());
        B64.encode(&hasher.finalize()[..16])
    }

    /// Whether this key matches `spec`'s check value (always true for specs
    /// without one).
    pub fn matches(&self, spec: &KeySpec) -> bool {
        spec.check().is_none_or(|check| check == self.check_value())
    }
}

/// Argon2id cost parameters (`m_kib` memory in KiB).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl KdfParams {
    /// 64 MiB, 3 passes, 1 lane.
    pub const DEFAULT: KdfParams = KdfParams {
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };

    /// Cheap parameters for tests only.
    pub const INSECURE_FOR_TESTS: KdfParams = KdfParams {
        m_kib: 64,
        t: 1,
        p: 1,
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    /// Not a vault file, or a damaged header.
    Malformed(String),
    /// A newer format version.
    Unsupported(u32),
    /// Authentication failed: wrong key or modified contents.
    Decrypt,
}

/// Derives the master key from a passphrase.
pub fn derive_key(
    passphrase: &str,
    salt: &[u8],
    params: KdfParams,
) -> Result<MasterKey, FormatError> {
    let argon_params = argon2::Params::new(params.m_kib, params.t, params.p, Some(32))
        .map_err(|e| FormatError::Malformed(format!("invalid key derivation parameters: {e}")))?;
    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, out.as_mut())
        .map_err(|e| FormatError::Malformed(format!("key derivation failed: {e}")))?;
    Ok(MasterKey(out))
}

/// A new passphrase key spec (fresh salt) and its key.
pub fn new_passphrase_key(
    passphrase: &str,
    params: KdfParams,
) -> Result<(KeySpec, MasterKey), FormatError> {
    let mut salt = [0u8; SALT_LEN];
    crate::fsutil::fill_random(&mut salt);
    let key = derive_key(passphrase, &salt, params)?;
    let spec = KeySpec::Passphrase {
        kdf: "argon2id".to_string(),
        m: params.m_kib,
        t: params.t,
        p: params.p,
        salt: B64.encode(salt),
        check: key.check_value(),
    };
    Ok((spec, key))
}

/// Derives the key of a passphrase spec. Fails with `Decrypt` when the
/// passphrase does not match the spec's check value.
pub fn key_for_passphrase(spec: &KeySpec, passphrase: &str) -> Result<MasterKey, FormatError> {
    let KeySpec::Passphrase {
        kdf, m, t, p, salt, ..
    } = spec
    else {
        return Err(FormatError::Malformed(
            "the vault is not passphrase protected".into(),
        ));
    };
    if kdf != "argon2id" {
        return Err(FormatError::Malformed(format!(
            "unknown key derivation '{kdf}'"
        )));
    }
    let salt = B64
        .decode(salt)
        .map_err(|_| FormatError::Malformed("invalid salt".into()))?;
    let key = derive_key(
        passphrase,
        &salt,
        KdfParams {
            m_kib: *m,
            t: *t,
            p: *p,
        },
    )?;
    if key.matches(spec) {
        Ok(key)
    } else {
        Err(FormatError::Decrypt)
    }
}

/// A parsed (still encrypted) vault file.
#[derive(Debug, Clone)]
pub struct Sealed {
    pub header: Header,
    header_line: String,
    ciphertext: Vec<u8>,
}

/// Parses the file text without decrypting it.
pub fn parse(text: &str) -> Result<Sealed, FormatError> {
    let mut lines = text.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| FormatError::Malformed("the file is empty".into()))?;
    let header: Header = serde_json::from_str(header_line)
        .map_err(|_| FormatError::Malformed("the header is not valid".into()))?;
    if header.format != FORMAT {
        return Err(FormatError::Malformed("not a JET Pilot vault".into()));
    }
    if header.v != VERSION {
        return Err(FormatError::Unsupported(header.v));
    }
    let body = lines.next().unwrap_or_default().trim();
    let ciphertext = B64
        .decode(body)
        .map_err(|_| FormatError::Malformed("the contents are not valid base64".into()))?;
    Ok(Sealed {
        header,
        header_line: header_line.to_string(),
        ciphertext,
    })
}

/// Decrypts a parsed file.
pub fn open(sealed: &Sealed, key: &MasterKey) -> Result<Contents, FormatError> {
    let nonce = B64
        .decode(&sealed.header.nonce)
        .ok()
        .filter(|n| n.len() == NONCE_LEN)
        .ok_or_else(|| FormatError::Malformed("invalid nonce".into()))?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| FormatError::Decrypt)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &sealed.ciphertext,
                    aad: sealed.header_line.as_bytes(),
                },
            )
            .map_err(|_| FormatError::Decrypt)?,
    );
    serde_json::from_slice(&plaintext)
        .map_err(|_| FormatError::Malformed("the contents are not valid".into()))
}

/// Encrypts `contents` into the file text, with a fresh nonce.
pub fn seal(key: &MasterKey, spec: &KeySpec, contents: &Contents) -> String {
    let mut nonce = [0u8; NONCE_LEN];
    crate::fsutil::fill_random(&mut nonce);
    let header = Header {
        format: FORMAT.to_string(),
        v: VERSION,
        key: spec.clone(),
        nonce: B64.encode(nonce),
    };
    let header_line = serde_json::to_string(&header).expect("a vault header always serializes");
    let plaintext =
        Zeroizing::new(serde_json::to_vec(contents).expect("vault contents always serialize"));
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).expect("the key is 32 bytes");
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: header_line.as_bytes(),
            },
        )
        .expect("encryption with a valid key cannot fail");
    format!("{header_line}\n{}\n", B64.encode(ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents_with(id: &str, value: serde_json::Value) -> Contents {
        let mut contents = Contents::default();
        contents.entries.insert(
            id.to_string(),
            StoredEntry {
                value,
                updated_at: 1,
            },
        );
        contents
    }

    #[test]
    fn seal_and_open_round_trip_with_fresh_nonces() {
        let key = MasterKey::generate();
        let spec = KeySpec::Keychain {
            account: "vault-x".into(),
        };
        let contents = contents_with("cluster:a:static", serde_json::json!({"token": "s3cr3t"}));
        let first = seal(&key, &spec, &contents);
        let second = seal(&key, &spec, &contents);
        assert_ne!(first, second, "every write uses a new nonce");
        assert!(!first.contains("s3cr3t"));
        assert!(first.starts_with(
            r#"{"format":"jpv","v":1,"key":{"type":"keychain","account":"vault-x"},"nonce":""#
        ));

        let sealed = parse(&first).unwrap();
        assert_eq!(open(&sealed, &key).unwrap(), contents);
        assert_eq!(
            open(&sealed, &MasterKey::generate()),
            Err(FormatError::Decrypt)
        );
    }

    #[test]
    fn tampering_is_detected() {
        let key = MasterKey::generate();
        let spec = KeySpec::Keychain {
            account: "vault-x".into(),
        };
        let text = seal(&key, &spec, &contents_with("a", serde_json::json!(1)));
        let (header, body) = text.split_once('\n').unwrap();

        // A changed header (same meaning, different bytes) fails the AAD.
        let spaced = format!("{} \n{body}", header);
        assert_eq!(
            open(&parse(&spaced).unwrap(), &key),
            Err(FormatError::Decrypt)
        );

        // A flipped ciphertext bit.
        let mut raw = B64.decode(body.trim()).unwrap();
        raw[3] ^= 1;
        let flipped = format!("{header}\n{}\n", B64.encode(raw));
        assert_eq!(
            open(&parse(&flipped).unwrap(), &key),
            Err(FormatError::Decrypt)
        );

        assert!(matches!(parse("nonsense"), Err(FormatError::Malformed(_))));
        assert!(matches!(parse(""), Err(FormatError::Malformed(_))));
        let future = text.replacen("\"v\":1", "\"v\":2", 1);
        assert_eq!(parse(&future).unwrap_err(), FormatError::Unsupported(2));
    }

    #[test]
    fn passphrase_keys_and_check_values() {
        let (spec, key) =
            new_passphrase_key("correct horse", KdfParams::INSECURE_FOR_TESTS).unwrap();
        assert!(key.matches(&spec));
        let again = key_for_passphrase(&spec, "correct horse").unwrap();
        assert_eq!(again.as_bytes(), key.as_bytes());
        assert_eq!(
            key_for_passphrase(&spec, "wrong").unwrap_err(),
            FormatError::Decrypt
        );
        assert!(!MasterKey::generate().matches(&spec));

        // Same passphrase, new salt: a different key.
        let (_, other) =
            new_passphrase_key("correct horse", KdfParams::INSECURE_FOR_TESTS).unwrap();
        assert_ne!(other.as_bytes(), key.as_bytes());

        let round = MasterKey::from_base64(&key.to_base64()).unwrap();
        assert_eq!(round.as_bytes(), key.as_bytes());
        assert_eq!(format!("{key:?}"), "MasterKey(<redacted>)");
    }
}
