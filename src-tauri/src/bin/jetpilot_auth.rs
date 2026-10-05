//! `jetpilot-auth`: the kubectl credential helper for clusters added in JET
//! Pilot. Entries in `~/.kube/jet-pilot/config` run it as an exec plugin:
//!
//! - `credential static --id <id>` prints the stored token / client
//!   certificate of a cluster as an `ExecCredential`;
//! - `credential wrap-exec --id <id> -- <cmd> <args...>` runs the original
//!   exec plugin with its secret environment variables from the vault;
//! - `credential aws-eks --connection <id> ...` mints an EKS token from the
//!   connection's AWS credentials (IAM Identity Center session, profile or
//!   access keys) without the aws CLI. It never signs in: an expired
//!   session exits 3 ("Sign in to AWS in JET Pilot").
//! - `credential digitalocean --connection <id> --cluster <id>` mints a
//!   short-lived DigitalOcean token with the connection's API token;
//! - `credential exoscale --connection <id> --zone <zone> --cluster <id>`
//!   mints an Exoscale client certificate with the connection's API key.
//!   Both are cached in the vault until shortly before they expire.
//!
//! stdout carries only the `ExecCredential` (or the wrapped plugin's own
//! output, untouched); human messages go to stderr through `redact()`. Exit
//! codes: 0 ok, 2 usage, 3 no stored credentials, 4 vault locked, 5 other.
//!
//! This binary uses the console subsystem on Windows on purpose (kubectl
//! reads its stdout), so it must never get `windows_subsystem = "windows"`.

use std::io::Write;

use jp_auth_core::aws::{self, AwsContext, AwsError};
use jp_auth_core::cloud::{self, CloudContext, CloudError};
use jp_auth_core::credentials::{env_secret_id, static_secret_id, EnvSecrets, StaticCredential};
use jp_auth_core::exec_credential::{api_version_from_env, ExecCredential, ExecCredentialStatus};
use jp_auth_core::request::{self, exit, AwsEksArgs, DigitaloceanArgs, ExoscaleArgs, Request};
use jp_auth_core::vault::{self, Backend, KeySpec, Vault, VaultEnv, VaultError};
use jp_auth_core::zeroize::Zeroizing;
use jp_auth_core::{paths, redact, PASSPHRASE_ENV};

const VERSION: &str = match option_env!("JET_PILOT_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() {
    // Never print a panic payload: it could contain credential data.
    std::panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!(" ({}:{})", l.file(), l.line()))
            .unwrap_or_default();
        let _ = writeln!(std::io::stderr(), "jetpilot-auth: internal error{at}");
        std::process::exit(exit::OTHER);
    }));
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    std::process::exit(run(args));
}

fn say(message: &str) {
    let _ = writeln!(std::io::stderr(), "jetpilot-auth: {}", redact(message));
}

fn fail(code: i32, message: &str) -> i32 {
    say(message);
    code
}

fn run(args: Vec<String>) -> i32 {
    let request = match request::parse(args) {
        Ok(request) => request,
        Err(e) => {
            let _ = writeln!(
                std::io::stderr(),
                "jetpilot-auth: {}\n\n{}",
                redact(&e.0),
                request::USAGE
            );
            return exit::USAGE;
        }
    };
    match request {
        Request::CredentialStatic { id } => credential_static(&id),
        Request::CredentialWrapExec { id, command, args } => wrap_exec(&id, &command, &args),
        Request::CredentialAwsEks(args) => aws_eks(&args),
        Request::CredentialDigitalocean(args) => cloud_credential(Minted::Digitalocean(args)),
        Request::CredentialExoscale(args) => cloud_credential(Minted::Exoscale(args)),
        Request::Unlock => unlock(),
        Request::Lock => lock(),
        Request::Doctor => doctor(),
        Request::Version => {
            println!("jetpilot-auth {VERSION}");
            exit::OK
        }
        Request::Help => {
            println!("{}", request::USAGE);
            exit::OK
        }
    }
}

/* ------------------------------------------------------------ the vault */

fn vault_failure(error: VaultError) -> i32 {
    match error {
        VaultError::Locked => fail(
            exit::LOCKED,
            "The JET Pilot vault is locked. Unlock it in JET Pilot (with \"also unlock for terminals\") or run `jetpilot-auth unlock`.",
        ),
        VaultError::KeychainUnavailable(reason) => fail(
            exit::LOCKED,
            &format!("The system keychain that holds the JET Pilot vault key is not available. {reason}"),
        ),
        VaultError::WrongPassphrase => fail(
            exit::LOCKED,
            &format!("The passphrase in {PASSPHRASE_ENV} is not correct."),
        ),
        other => fail(exit::OTHER, &other.to_string()),
    }
}

/// Opens the vault; a locked passphrase vault is opened with
/// `JET_PILOT_VAULT_PASSPHRASE` when that is set.
fn open_vault(env: &VaultEnv) -> Result<Vault, i32> {
    match Vault::open_with(env, None) {
        Err(VaultError::Locked) => {
            let passphrase = Zeroizing::new(std::env::var(PASSPHRASE_ENV).unwrap_or_default());
            if passphrase.is_empty() {
                return Err(vault_failure(VaultError::Locked));
            }
            let key = Vault::key_from_passphrase(env, &passphrase).map_err(vault_failure)?;
            Vault::open_with(env, Some(&key)).map_err(vault_failure)
        }
        other => other.map_err(vault_failure),
    }
}

fn missing_credentials(id: &str) -> i32 {
    fail(
        exit::NOT_FOUND,
        &format!(
            "No credentials are stored for this cluster (id {id}). Open JET Pilot and add the cluster again."
        ),
    )
}

/* ---------------------------------------------------------- credentials */

fn credential_static(id: &str) -> i32 {
    let env = VaultEnv::system();
    let vault = match open_vault(&env) {
        Ok(vault) => vault,
        Err(code) => return code,
    };
    let Some(value) = vault.get(&static_secret_id(id)) else {
        return missing_credentials(id);
    };
    drop(vault);
    let credential: StaticCredential = match serde_json::from_value(value) {
        Ok(credential) => credential,
        Err(_) => {
            return fail(
                exit::OTHER,
                "The stored credentials of this cluster are not valid.",
            )
        }
    };
    if credential.is_empty() {
        return missing_credentials(id);
    }
    print_credential(&credential.to_exec_credential(&api_version_from_env()))
}

/// Writes the ExecCredential to stdout (the only thing ever printed there).
fn print_credential(credential: &ExecCredential) -> i32 {
    let json = Zeroizing::new(credential.to_json());
    let mut stdout = std::io::stdout().lock();
    let written = stdout
        .write_all(json.as_bytes())
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush());
    match written {
        Ok(()) => exit::OK,
        Err(e) => fail(exit::OTHER, &format!("Could not write the credential: {e}")),
    }
}

/* ------------------------------------------------------------------ aws */

/// The in-app key of a passphrase vault that is locked for terminals but
/// unlockable with `JET_PILOT_VAULT_PASSPHRASE`. Vault problems are only
/// reported when the vault is actually needed (an SSO session may come
/// from `~/.aws/sso/cache` alone).
fn passphrase_session(env: &VaultEnv) -> Option<jp_auth_core::vault::MasterKey> {
    match Vault::open_with(env, None) {
        Err(VaultError::Locked) => {
            let passphrase = Zeroizing::new(std::env::var(PASSPHRASE_ENV).unwrap_or_default());
            if passphrase.is_empty() {
                return None;
            }
            Vault::key_from_passphrase(env, &passphrase).ok()
        }
        _ => None,
    }
}

fn aws_eks(args: &AwsEksArgs) -> i32 {
    let env = VaultEnv::system();
    let session = passphrase_session(&env);
    let ctx = AwsContext::system(vault::Store::new(env, session));
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => return fail(exit::OTHER, &format!("Could not start: {e}")),
    };
    let result = runtime.block_on(async {
        let credentials = aws::creds::for_eks(&ctx, args).await?;
        aws::token::eks_token(
            &credentials,
            &args.region,
            &args.cluster,
            std::time::SystemTime::now(),
            None,
        )
    });
    match result {
        Ok((token, expires_at)) => print_credential(&ExecCredential::new(
            api_version_from_env(),
            ExecCredentialStatus {
                expiration_timestamp: Some(jp_auth_core::time::format_rfc3339(expires_at)),
                token: Some(token),
                ..Default::default()
            },
        )),
        Err(AwsError::SignInRequired(message)) => fail(
            exit::NOT_FOUND,
            &format!("Sign in to AWS in JET Pilot. {message}"),
        ),
        Err(AwsError::MfaRequired(message)) => fail(exit::NOT_FOUND, &message),
        Err(AwsError::NotFound(message)) => fail(exit::NOT_FOUND, &message),
        Err(AwsError::Vault(error)) => vault_failure(error),
        Err(other) => fail(exit::OTHER, &other.to_string()),
    }
}

/* ---------------------------------------------------------------- clouds */

enum Minted {
    Digitalocean(DigitaloceanArgs),
    Exoscale(ExoscaleArgs),
}

fn cloud_credential(request: Minted) -> i32 {
    let env = VaultEnv::system();
    let session = passphrase_session(&env);
    let ctx = CloudContext::system(vault::Store::new(env, session));
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => return fail(exit::OTHER, &format!("Could not start: {e}")),
    };
    let result = runtime.block_on(async {
        match &request {
            Minted::Digitalocean(args) => cloud::mint::digitalocean(&ctx, args).await,
            Minted::Exoscale(args) => cloud::mint::exoscale(&ctx, args).await,
        }
    });
    let provider = match request {
        Minted::Digitalocean(_) => "DigitalOcean",
        Minted::Exoscale(_) => "Exoscale",
    };
    match result {
        Ok(credential) => print_credential(&credential.to_exec_credential(&api_version_from_env())),
        Err(CloudError::Unauthorized(message)) => fail(
            exit::NOT_FOUND,
            &format!(
                "{message}. Update the {provider} credentials of this connection in JET Pilot."
            ),
        ),
        Err(CloudError::MissingCredentials(message)) | Err(CloudError::NotFound(message)) => {
            fail(exit::NOT_FOUND, &message)
        }
        Err(CloudError::Vault(error)) => vault_failure(error),
        Err(other) => fail(exit::OTHER, &other.to_string()),
    }
}

fn wrap_exec(id: &str, command: &str, args: &[String]) -> i32 {
    let env = VaultEnv::system();
    let vault = match open_vault(&env) {
        Ok(vault) => vault,
        Err(code) => return code,
    };
    let Some(value) = vault.get(&env_secret_id(id)) else {
        return missing_credentials(id);
    };
    drop(vault);
    let secrets: EnvSecrets = match serde_json::from_value(value) {
        Ok(secrets) => secrets,
        Err(_) => {
            return fail(
                exit::OTHER,
                "The stored environment of this cluster is not valid.",
            )
        }
    };

    // stdin/stdout/stderr are inherited: the plugin's ExecCredential reaches
    // kubectl untouched, and so do its prompts.
    let mut cmd = std::process::Command::new(command);
    cmd.args(args);
    for (name, value) in &secrets {
        cmd.env(name, value);
    }
    drop(secrets);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Only returns on failure.
        let error = cmd.exec();
        exec_failure(command, &error)
    }
    #[cfg(not(unix))]
    {
        match cmd.status() {
            Ok(status) => status.code().unwrap_or(exit::OTHER),
            Err(error) => exec_failure(command, &error),
        }
    }
}

fn exec_failure(command: &str, error: &std::io::Error) -> i32 {
    if error.kind() == std::io::ErrorKind::NotFound {
        fail(
            exit::OTHER,
            &format!("The credential plugin {command} was not found. Install it, or add the cluster again in JET Pilot."),
        )
    } else {
        fail(
            exit::OTHER,
            &format!("Could not run the credential plugin {command}: {error}"),
        )
    }
}

/* ------------------------------------------------------- unlock / lock */

fn unlock() -> i32 {
    let env = VaultEnv::system();
    match vault::peek(&env) {
        Ok(None) => return fail(exit::OTHER, "The JET Pilot vault has not been set up yet."),
        Ok(Some(KeySpec::Keychain { .. })) => {
            say("The JET Pilot vault uses the system keychain; there is nothing to unlock.");
            return exit::OK;
        }
        Ok(Some(KeySpec::Passphrase { .. })) => {}
        Err(e) => return vault_failure(e),
    }
    if !env.unlock_cache.available() {
        return fail(
            exit::OTHER,
            "Unlocking for terminals needs the Linux kernel keyring, which is not available here.",
        );
    }
    let passphrase = match rpassword::prompt_password("JET Pilot vault passphrase: ") {
        Ok(passphrase) => Zeroizing::new(passphrase),
        Err(e) => {
            return fail(
                exit::USAGE,
                &format!("Could not read the passphrase from the terminal: {e}"),
            )
        }
    };
    let key = match Vault::key_from_passphrase(&env, &passphrase) {
        Ok(key) => key,
        Err(VaultError::WrongPassphrase) => {
            return fail(exit::LOCKED, "The passphrase is not correct.")
        }
        Err(e) => return vault_failure(e),
    };
    if let Err(reason) = Vault::cache_unlock(&env, &key) {
        return fail(exit::OTHER, &reason);
    }
    say("Unlocked for terminals for 12 hours.");
    exit::OK
}

fn lock() -> i32 {
    Vault::lock_terminals(&VaultEnv::system());
    say("Locked. Terminals need to unlock the vault again.");
    exit::OK
}

/* --------------------------------------------------------------- doctor */

fn doctor() -> i32 {
    let env = VaultEnv::system();
    let present = |path: &std::path::Path| if path.exists() { "present" } else { "missing" };
    let kubeconfig = paths::managed_kubeconfig();
    let helper = paths::helper_path();
    let status = Vault::status(&env, None);

    let mut lines = vec![
        format!("jetpilot-auth {VERSION}"),
        format!("home                {}", paths::jet_pilot_home().display()),
        format!(
            "managed kubeconfig  {} ({})",
            kubeconfig.display(),
            present(&kubeconfig)
        ),
        format!(
            "installed helper    {} ({})",
            helper.display(),
            present(&helper)
        ),
        format!(
            "vault file          {} ({})",
            env.file().display(),
            present(&env.file())
        ),
    ];
    let backend = match (status.initialized, status.backend) {
        (false, Backend::Keychain) => "not set up (will use the system keychain)",
        (false, _) => "not set up (needs a passphrase: no system keychain)",
        (true, Backend::Keychain) => "system keychain",
        (true, Backend::Passphrase) => "passphrase",
        (true, Backend::None) => "unreadable",
    };
    lines.push(format!("vault backend       {backend}"));
    if status.initialized {
        lines.push(format!(
            "vault state         {}",
            if status.locked { "locked" } else { "unlocked" }
        ));
    }
    lines.push(match &status.keychain_problem {
        None => "system keychain     available".to_string(),
        Some(problem) => format!("system keychain     unavailable: {problem}"),
    });
    lines.push(format!(
        "terminal unlock     {}",
        if !env.unlock_cache.available() {
            "not supported on this system"
        } else if status.unlock_cached {
            "unlocked (kernel keyring)"
        } else {
            "not unlocked"
        }
    ));
    let mut stdout = std::io::stdout().lock();
    for line in lines {
        let _ = writeln!(stdout, "{}", redact(&line));
    }
    exit::OK
}
