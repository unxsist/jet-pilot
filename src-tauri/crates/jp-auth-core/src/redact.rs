//! Masking secrets in human-readable text (helper stderr, login output, log
//! lines): JWTs, EKS (`k8s-aws-v1.`) and DigitalOcean (`dop_v1_`) tokens,
//! PEM private keys, AWS secret keys and `token: ...`-style values.
//!
//! The scanner is hand-written (no regex) to keep the helper small. All
//! patterns are ASCII, so replacements always happen at char boundaries.

/// What a masked value is replaced with.
pub const MASK: &str = "[REDACTED]";

/// `text` with every recognised secret masked.
pub fn redact(text: &str) -> String {
    let text = redact_private_keys(text);
    let text = redact_prefixed_tokens(&text);
    let text = redact_jwts(&text);
    let text = redact_key_values(&text);
    redact_aws_secret_keys(&text)
}

/* ------------------------------------------------------------- PEM keys */

fn redact_private_keys(text: &str) -> String {
    const BEGIN: &str = "-----BEGIN ";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let after_begin = &rest[start + BEGIN.len()..];
        let Some(label_end) = after_begin.find("-----") else {
            break;
        };
        let label = &after_begin[..label_end];
        if !label.contains("PRIVATE KEY") || label.contains('\n') {
            let skip = start + BEGIN.len();
            out.push_str(&rest[..skip]);
            rest = &rest[skip..];
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str("[REDACTED PRIVATE KEY]");
        let end_marker = format!("-----END {label}-----");
        match rest[start..].find(&end_marker) {
            Some(end) => rest = &rest[start + end + end_marker.len()..],
            // An unterminated key: everything after BEGIN may be key data.
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/* --------------------------------------------------------------- tokens */

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'=' | b'+' | b'/')
}

fn is_base64url_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')
}

/// `k8s-aws-v1.<presigned url>`, `dop_v1_<hex>` (and DO's OAuth variants).
fn redact_prefixed_tokens(text: &str) -> String {
    const PREFIXES: &[&str] = &["k8s-aws-v1.", "dop_v1_", "doo_v1_", "dor_v1_"];
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        let prefix = PREFIXES
            .iter()
            .find(|p| bytes[i..].starts_with(p.as_bytes()));
        if let Some(prefix) = prefix {
            let value_start = i + prefix.len();
            let mut end = value_start;
            while end < bytes.len() && is_token_byte(bytes[end]) {
                end += 1;
            }
            if end > value_start {
                out.push_str(&text[copied..value_start]);
                out.push_str(MASK);
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// `eyJ<header>.<payload>[.<signature>]`.
fn redact_jwts(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i + 3 <= bytes.len() {
        let boundary = i == 0 || !is_base64url_byte(bytes[i - 1]);
        if boundary && bytes[i..].starts_with(b"eyJ") {
            if let Some(end) = jwt_end(bytes, i) {
                out.push_str(&text[copied..i]);
                out.push_str(MASK);
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// End of a JWT starting at `start`: at least a header and a payload
/// segment, optionally more (signature, JWE parts).
fn jwt_end(bytes: &[u8], start: usize) -> Option<usize> {
    let segment = |from: usize| {
        let mut end = from;
        while end < bytes.len() && is_base64url_byte(bytes[end]) {
            end += 1;
        }
        end
    };
    let header_end = segment(start);
    if header_end - start < 10 || bytes.get(header_end) != Some(&b'.') {
        return None;
    }
    let payload_end = segment(header_end + 1);
    if payload_end - header_end - 1 < 2 {
        return None;
    }
    let mut end = payload_end;
    while bytes.get(end) == Some(&b'.') {
        let next = segment(end + 1);
        if next == end + 1 {
            break;
        }
        end = next;
    }
    Some(end)
}

/* ----------------------------------------------------------- key: value */

/// Whether an identifier names a secret: `token`, `password`, `secret`,
/// `client-key-data`, `authorization`, `api_key`, ... (case, `-` and `_`
/// insensitive, as a suffix: `AWS_SESSION_TOKEN`, `id-token`, ...).
fn is_secret_key(identifier: &str) -> bool {
    let normalized: String = identifier
        .chars()
        .filter(|c| *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect();
    [
        "token",
        "password",
        "passwd",
        "secret",
        "secretaccesskey",
        "keydata",
        "privatekey",
        "authorization",
        "apikey",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn is_identifier_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Masks the value of `key: value`, `key=value`, `"key": "value"` and
/// `Authorization: Bearer value` when the key names a secret.
fn redact_key_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !is_identifier_byte(bytes[i]) || (i > 0 && is_identifier_byte(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let key_start = i;
        while i < bytes.len() && is_identifier_byte(bytes[i]) {
            i += 1;
        }
        if !is_secret_key(&text[key_start..i]) {
            continue;
        }
        let mut j = i;
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            j += 1;
        }
        while j < bytes.len() && bytes[j] == b' ' {
            j += 1;
        }
        if j >= bytes.len() || (bytes[j] != b':' && bytes[j] != b'=') {
            continue;
        }
        j += 1;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        let Some((value_start, value_end)) = value_span(bytes, j) else {
            continue;
        };
        let value = &text[value_start..value_end];
        let (value_start, value_end) =
            if value.eq_ignore_ascii_case("bearer") || value.eq_ignore_ascii_case("basic") {
                let mut k = value_end;
                while k < bytes.len() && bytes[k] == b' ' {
                    k += 1;
                }
                match value_span(bytes, k) {
                    Some(span) => span,
                    None => continue,
                }
            } else {
                (value_start, value_end)
            };
        if &text[value_start..value_end] == MASK {
            i = value_end;
            continue;
        }
        out.push_str(&text[copied..value_start]);
        out.push_str(MASK);
        copied = value_end;
        i = value_end;
    }
    out.push_str(&text[copied..]);
    out
}

/// The value starting at `start`: a quoted string's contents, or the run of
/// characters up to whitespace / `,` / `}` / `]`. None when empty or when
/// it is a YAML block indicator (`|`, `>`) or the start of a structure.
fn value_span(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    let first = *bytes.get(start)?;
    if first == b'"' || first == b'\'' {
        let mut end = start + 1;
        while end < bytes.len() && bytes[end] != first && bytes[end] != b'\n' {
            if bytes[end] == b'\\' && first == b'"' {
                end += 1;
            }
            end += 1;
        }
        let end = end.min(bytes.len());
        return (end > start + 1).then_some((start + 1, end));
    }
    if matches!(first, b'|' | b'>' | b'{' | b'[' | b'\n' | b'\r' | b'#') {
        return None;
    }
    let mut end = start;
    while end < bytes.len()
        && !bytes[end].is_ascii_whitespace()
        && !matches!(bytes[end], b',' | b'}' | b']' | b'"' | b'\'')
    {
        end += 1;
    }
    (end > start).then_some((start, end))
}

/* ------------------------------------------------------ AWS secret keys */

/// Standalone 40-character AWS secret access keys: base64 alphabet, with
/// upper and lower case letters and a digit, `/` or `+` (so hex digests
/// such as git hashes are left alone).
fn redact_aws_secret_keys(text: &str) -> String {
    fn is_key_byte(b: u8) -> bool {
        b.is_ascii_alphanumeric() || b == b'/' || b == b'+'
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !is_key_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_key_byte(bytes[i]) {
            i += 1;
        }
        let run = &bytes[start..i];
        let preceded_ok = start == 0 || !matches!(bytes[start - 1], b'=' | b'-' | b'_' | b'.');
        let followed_ok = i == bytes.len() || !matches!(bytes[i], b'=' | b'-' | b'_' | b'.');
        if run.len() == 40
            && preceded_ok
            && followed_ok
            && run.iter().any(u8::is_ascii_uppercase)
            && run.iter().any(u8::is_ascii_lowercase)
            && run
                .iter()
                .any(|b| b.is_ascii_digit() || *b == b'/' || *b == b'+')
        {
            out.push_str(&text[copied..start]);
            out.push_str(MASK);
            copied = i;
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const JWT: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQifQ.c2lnbmF0dXJlLWJ5dGVz";

    #[test]
    fn redaction_table() {
        let aws_secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let cases: Vec<(String, String)> = vec![
            (format!("token {JWT} expired"), format!("token {MASK} expired")),
            (format!("Bearer {JWT}"), format!("Bearer {MASK}")),
            (
                "got k8s-aws-v1.aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8_QWN0aW9u done".into(),
                format!("got k8s-aws-v1.{MASK} done"),
            ),
            (
                "dop_v1_0123456789abcdef0123456789abcdef".into(),
                format!("dop_v1_{MASK}"),
            ),
            (
                "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\nb".into(),
                "a\n[REDACTED PRIVATE KEY]\nb".into(),
            ),
            (
                "-----BEGIN PRIVATE KEY-----\nMIIE truncated".into(),
                "[REDACTED PRIVATE KEY]".into(),
            ),
            (
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----".into(),
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----".into(),
            ),
            ("    token: abc123secret".into(), format!("    token: {MASK}")),
            (
                r#"{"token":"abc","expirationTimestamp":"2026-01-01T00:00:00Z"}"#.into(),
                format!(r#"{{"token":"{MASK}","expirationTimestamp":"2026-01-01T00:00:00Z"}}"#),
            ),
            (
                "AWS_SECRET_ACCESS_KEY=supersecret AWS_PROFILE=dev".into(),
                format!("AWS_SECRET_ACCESS_KEY={MASK} AWS_PROFILE=dev"),
            ),
            (
                "aws_session_token = IQoJb3JpZ2luX2Vj".into(),
                format!("aws_session_token = {MASK}"),
            ),
            (
                "Authorization: Bearer opaque-token".into(),
                format!("Authorization: Bearer {MASK}"),
            ),
            ("--token=xyz --server=https://x".into(), format!("--token={MASK} --server=https://x")),
            ("client-key-data: LS0tLS1C".into(), format!("client-key-data: {MASK}")),
            ("password: 'hunter2'".into(), format!("password: '{MASK}'")),
            (format!("secret key {aws_secret} here"), format!("secret key {MASK} here")),
            // Not secrets.
            ("tokenFile: /var/run/token".into(), "tokenFile: /var/run/token".into()),
            ("token_type: Bearer".into(), "token_type: Bearer".into()),
            (
                "commit 3f786850e387550fdab836ed7e6dc881de23001b".into(),
                "commit 3f786850e387550fdab836ed7e6dc881de23001b".into(),
            ),
            ("token:".into(), "token:".into()),
            ("token: |".into(), "token: |".into()),
            ("plain text, nothing to see".into(), "plain text, nothing to see".into()),
            ("ünïcödé token: v ✓".into(), format!("ünïcödé token: {MASK} ✓")),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(&input), expected, "input: {input}");
        }
    }

    #[test]
    fn redaction_is_idempotent() {
        let text = format!("token: {JWT}\nAuthorization: Bearer x\nk8s-aws-v1.abc");
        let once = redact(&text);
        assert_eq!(redact(&once), once);
        assert!(!once.contains("eyJ"));
    }
}
