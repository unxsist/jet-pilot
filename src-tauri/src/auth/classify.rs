//! Static classification of a kubeconfig user's auth configuration: can a
//! client for it be built without a human (no browser, no device code, no
//! prompt)?
//!
//! The class only looks at the kubeconfig, never runs anything. It follows
//! kube-rs' precedence (auth provider, basic auth, token, token file, exec)
//! so it describes what building a client would actually run:
//!
//! - `NonInteractive`: static credentials (token, token file, client
//!   certificate, basic auth, none at all), the OIDC auth provider (refreshed
//!   over HTTP) and exec plugins known to never prompt: `aws`,
//!   `aws-iam-authenticator`, `gke-gcloud-auth-plugin`, `doctl`,
//!   `jetpilot-auth`, and Azure `kubelogin get-token` with a non-interactive
//!   login mode (`azurecli`, `spn`, `msi`, `workloadidentity`, `azd`).
//! - `Interactive`: exec plugins that open a browser or show a device code:
//!   `kubelogin` without a login mode (it defaults to devicecode) or with
//!   `devicecode` / `interactive` / `ropc`, `kubectl oidc-login`,
//!   `kubectl-oidc_login`, `pinniped` and `tsh`.
//! - `Unknown`: anything else (other exec plugins, the removed `gcp` /
//!   `azure` auth providers, which can run commands too). Callers treat it
//!   like `Interactive`.

use kube::config::{AuthInfo, ExecConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InteractiveClass {
    NonInteractive,
    Interactive,
    Unknown,
}

/// Exec plugins that never prompt.
const NON_INTERACTIVE_COMMANDS: &[&str] = &[
    "aws",
    "aws-iam-authenticator",
    "gke-gcloud-auth-plugin",
    "doctl",
    "jetpilot-auth",
];

/// Exec plugins that always need a human (browser / device code / prompt).
const INTERACTIVE_COMMANDS: &[&str] = &["kubectl-oidc_login", "kubectl-oidc-login", "pinniped", "tsh"];

/// Azure kubelogin login modes that never prompt.
const KUBELOGIN_NON_INTERACTIVE: &[&str] = &["azurecli", "spn", "msi", "workloadidentity", "azd"];

/// Azure kubelogin login modes that need a human.
const KUBELOGIN_INTERACTIVE: &[&str] = &["devicecode", "interactive", "ropc"];

/// Classifies the auth configuration of a kubeconfig user (see the module
/// docs).
pub fn classify_auth(auth: &AuthInfo) -> InteractiveClass {
    if let Some(provider) = &auth.auth_provider {
        return if provider.name == "oidc" {
            InteractiveClass::NonInteractive
        } else {
            InteractiveClass::Unknown
        };
    }
    // kube-rs only uses basic auth when both halves are set.
    if auth.username.is_some() && auth.password.is_some() {
        return InteractiveClass::NonInteractive;
    }
    // A token (inline or file) wins over exec: the plugin never runs.
    if auth.token.is_some() || auth.token_file.is_some() {
        return InteractiveClass::NonInteractive;
    }
    match &auth.exec {
        Some(exec) => classify_exec(exec),
        // Client certificates or no credentials at all.
        None => InteractiveClass::NonInteractive,
    }
}

fn classify_exec(exec: &ExecConfig) -> InteractiveClass {
    let Some(command) = exec.command.as_deref() else {
        return InteractiveClass::Unknown;
    };
    let name = command_basename(command);
    let is = |candidate: &str| name.eq_ignore_ascii_case(candidate);
    let args = exec.args.as_deref().unwrap_or_default();

    if NON_INTERACTIVE_COMMANDS.iter().any(|c| is(c)) {
        InteractiveClass::NonInteractive
    } else if INTERACTIVE_COMMANDS.iter().any(|c| is(c)) {
        InteractiveClass::Interactive
    } else if is("kubelogin") {
        classify_kubelogin(args, exec)
    } else if is("kubectl") {
        if args.first().is_some_and(|arg| arg == "oidc-login") {
            InteractiveClass::Interactive
        } else {
            InteractiveClass::Unknown
        }
    } else {
        InteractiveClass::Unknown
    }
}

/// Azure kubelogin defaults to devicecode; the login mode comes from
/// `-l` / `--login` (last one wins), else `AAD_LOGIN_METHOD` in the exec
/// env. int128/kubelogin (OIDC) has no login flag and lands on interactive,
/// which is what it is.
fn classify_kubelogin(args: &[String], exec: &ExecConfig) -> InteractiveClass {
    let mode = login_mode(args)
        .map(str::to_string)
        .or_else(|| exec_env(exec, "AAD_LOGIN_METHOD"))
        .map(|mode| mode.trim().to_ascii_lowercase())
        .filter(|mode| !mode.is_empty());
    let Some(mode) = mode else {
        return InteractiveClass::Interactive;
    };
    if KUBELOGIN_INTERACTIVE.contains(&mode.as_str()) {
        InteractiveClass::Interactive
    } else if KUBELOGIN_NON_INTERACTIVE.contains(&mode.as_str())
        && args.iter().any(|arg| arg == "get-token")
    {
        InteractiveClass::NonInteractive
    } else {
        InteractiveClass::Unknown
    }
}

/// The value of the last `-l` / `--login` flag (`-l x`, `-l=x`, `-lx`,
/// `--login x`, `--login=x`).
fn login_mode(args: &[String]) -> Option<&str> {
    let mut mode = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-l" || arg == "--login" {
            mode = iter.next().map(String::as_str);
        } else if let Some(value) = arg.strip_prefix("--login=") {
            mode = Some(value);
        } else if let Some(value) = arg.strip_prefix("-l").filter(|v| !v.is_empty()) {
            mode = Some(value.strip_prefix('=').unwrap_or(value));
        }
    }
    mode
}

fn exec_env(exec: &ExecConfig, name: &str) -> Option<String> {
    exec.env
        .as_ref()?
        .iter()
        .find(|env| env.get("name").map(String::as_str) == Some(name))
        .and_then(|env| env.get("value").cloned())
}

/// The file name of an exec command without directories (`/` or `\`, the
/// kubeconfig may come from another OS) and without a `.exe` / `.cmd`
/// extension: `C:\bin\kubelogin.exe` → `kubelogin`. Never includes args or
/// env, so it is safe to show.
pub fn command_basename(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = name.to_ascii_lowercase();
    for extension in [".exe", ".cmd"] {
        if lower.ends_with(extension) && name.len() > extension.len() {
            return name[..name.len() - extension.len()].to_string();
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::config::{AuthProviderConfig, Kubeconfig};
    use std::collections::HashMap;
    use InteractiveClass::{Interactive, NonInteractive, Unknown};

    fn exec(command: &str, args: &[&str]) -> AuthInfo {
        AuthInfo {
            exec: Some(ExecConfig {
                api_version: Some("client.authentication.k8s.io/v1beta1".into()),
                command: Some(command.into()),
                args: Some(args.iter().map(|a| a.to_string()).collect()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn with_env(mut auth: AuthInfo, name: &str, value: &str) -> AuthInfo {
        let env = HashMap::from([
            ("name".to_string(), name.to_string()),
            ("value".to_string(), value.to_string()),
        ]);
        auth.exec.as_mut().unwrap().env = Some(vec![env]);
        auth
    }

    fn provider(name: &str) -> AuthInfo {
        AuthInfo {
            auth_provider: Some(AuthProviderConfig {
                name: name.into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Parses the `user:` body of a kubeconfig user.
    fn user(yaml: &str) -> AuthInfo {
        let body: String = yaml.lines().map(|line| format!("    {line}\n")).collect();
        let doc = format!("apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n{body}");
        Kubeconfig::from_yaml(&doc).unwrap().auth_infos[0]
            .auth_info
            .clone()
            .unwrap()
    }

    #[test]
    fn exec_plugins_are_classified_by_command_and_args() {
        let table: &[(&str, &[&str], InteractiveClass)] = &[
            // Known non-interactive plugins, any path / extension / case.
            ("aws", &["eks", "get-token", "--cluster-name", "prod"], NonInteractive),
            ("/usr/local/bin/aws", &["eks", "get-token"], NonInteractive),
            (r"C:\Program Files\Amazon\AWSCLIV2\aws.exe", &["eks", "get-token"], NonInteractive),
            ("aws-iam-authenticator", &["token", "-i", "prod"], NonInteractive),
            ("gke-gcloud-auth-plugin", &[], NonInteractive),
            (r"C:\gcloud\bin\gke-gcloud-auth-plugin.exe", &[], NonInteractive),
            ("doctl", &["kubernetes", "cluster", "kubeconfig", "exec-credential", "--version=v1beta1", "abc"], NonInteractive),
            ("/home/me/.kube/jet-pilot/bin/jetpilot-auth", &["credential", "static", "--id", "x"], NonInteractive),
            ("AWS.EXE", &["eks", "get-token"], NonInteractive),
            // Azure kubelogin: login mode decides.
            ("kubelogin", &["get-token", "--login", "azurecli", "--server-id", "x"], NonInteractive),
            ("kubelogin", &["get-token", "-l", "spn", "--server-id", "x"], NonInteractive),
            ("kubelogin", &["get-token", "--login=msi"], NonInteractive),
            ("kubelogin", &["get-token", "-l=workloadidentity"], NonInteractive),
            ("kubelogin", &["get-token", "-lazd"], NonInteractive),
            ("kubelogin", &["get-token", "--login", "AzureCLI"], NonInteractive),
            (r"C:\tools\kubelogin.exe", &["get-token", "-l", "azurecli"], NonInteractive),
            ("kubelogin", &["get-token", "--server-id", "x"], Interactive),
            ("kubelogin", &["get-token", "--login", "devicecode"], Interactive),
            ("kubelogin", &["get-token", "-l", "interactive"], Interactive),
            ("kubelogin", &["get-token", "--login=ropc"], Interactive),
            // The last flag wins, like pflag.
            ("kubelogin", &["get-token", "-l", "azurecli", "-l", "devicecode"], Interactive),
            ("kubelogin", &["get-token", "-l", "devicecode", "--login=azurecli"], NonInteractive),
            ("kubelogin", &["get-token", "--login", "somethingnew"], Unknown),
            // A flag without its value leaves the default (devicecode).
            ("kubelogin", &["get-token", "--login"], Interactive),
            // Non-interactive mode, but not a token request.
            ("kubelogin", &["convert-kubeconfig", "-l", "azurecli"], Unknown),
            // int128/kubelogin (OIDC in a browser).
            ("kubelogin", &["get-token", "--oidc-issuer-url=https://issuer", "--oidc-client-id=x"], Interactive),
            // OIDC login plugins, pinniped, teleport.
            ("kubectl", &["oidc-login", "get-token", "--oidc-issuer-url=https://issuer"], Interactive),
            ("/usr/bin/kubectl", &["oidc-login", "get-token"], Interactive),
            ("kubectl", &["get-token", "oidc-login"], Unknown),
            ("kubectl", &[], Unknown),
            ("kubectl-oidc_login", &["get-token"], Interactive),
            ("kubectl-oidc-login", &["get-token"], Interactive),
            ("/opt/pinniped", &["login", "oidc", "--issuer", "https://issuer"], Interactive),
            ("tsh", &["kube", "credentials", "--kube-cluster=prod"], Interactive),
            (r"C:\teleport\tsh.exe", &["kube", "credentials"], Interactive),
            // Everything else is unknown.
            ("gcloud", &["config", "config-helper"], Unknown),
            ("az", &["account", "get-access-token"], Unknown),
            ("/opt/scripts/get-token.sh", &[], Unknown),
            ("kubectl-krew", &[], Unknown),
            ("", &[], Unknown),
        ];
        for (command, args, expected) in table {
            assert_eq!(
                classify_auth(&exec(command, args)),
                *expected,
                "{command} {args:?}"
            );
        }
    }

    #[test]
    fn kubelogin_login_mode_can_come_from_the_exec_env() {
        let azurecli = with_env(exec("kubelogin", &["get-token"]), "AAD_LOGIN_METHOD", "azurecli");
        assert_eq!(classify_auth(&azurecli), NonInteractive);

        let devicecode = with_env(exec("kubelogin", &["get-token"]), "AAD_LOGIN_METHOD", "devicecode");
        assert_eq!(classify_auth(&devicecode), Interactive);

        // The flag wins over the env.
        let flag = with_env(
            exec("kubelogin", &["get-token", "-l", "devicecode"]),
            "AAD_LOGIN_METHOD",
            "azurecli",
        );
        assert_eq!(classify_auth(&flag), Interactive);

        let empty = with_env(exec("kubelogin", &["get-token"]), "AAD_LOGIN_METHOD", " ");
        assert_eq!(classify_auth(&empty), Interactive);
    }

    #[test]
    fn exec_without_a_command_is_unknown() {
        let auth = AuthInfo {
            exec: Some(ExecConfig::default()),
            ..Default::default()
        };
        assert_eq!(classify_auth(&auth), Unknown);
    }

    #[test]
    fn static_credentials_and_providers() {
        let table: &[(&str, AuthInfo, InteractiveClass)] = &[
            ("none", AuthInfo::default(), NonInteractive),
            ("token", user("token: abc"), NonInteractive),
            ("token file", user("tokenFile: /var/run/token"), NonInteractive),
            ("client cert files", user("client-certificate: c.crt\nclient-key: c.key"), NonInteractive),
            ("client cert data", user("client-certificate-data: Q0VSVA==\nclient-key-data: S0VZ"), NonInteractive),
            ("basic", user("username: admin\npassword: secret"), NonInteractive),
            ("username only", user("username: admin"), NonInteractive),
            ("oidc provider", provider("oidc"), NonInteractive),
            ("gcp provider", provider("gcp"), Unknown),
            ("azure provider", provider("azure"), Unknown),
            ("other provider", provider("custom"), Unknown),
        ];
        for (name, auth, expected) in table {
            assert_eq!(classify_auth(auth), *expected, "{name}");
        }
    }

    #[test]
    fn precedence_follows_kube_rs() {
        // A token wins over an interactive exec plugin: it never runs.
        let mut auth = exec("kubelogin", &["get-token", "-l", "devicecode"]);
        auth.token = Some("abc".to_string().into());
        assert_eq!(classify_auth(&auth), NonInteractive);

        let mut auth = exec("kubelogin", &["get-token"]);
        auth.token_file = Some("/token".into());
        assert_eq!(classify_auth(&auth), NonInteractive);

        // Client certificates are a TLS identity; the plugin still runs.
        let mut auth = exec("tsh", &["kube", "credentials"]);
        auth.client_certificate_data = Some("Q0VSVA==".into());
        assert_eq!(classify_auth(&auth), Interactive);

        // The auth provider wins over everything.
        let mut auth = provider("gcp");
        auth.token = Some("abc".to_string().into());
        assert_eq!(classify_auth(&auth), Unknown);
        let mut auth = provider("oidc");
        auth.exec = exec("kubelogin", &[]).exec;
        assert_eq!(classify_auth(&auth), NonInteractive);

        // Basic auth needs both halves.
        let mut auth = exec("pinniped", &[]);
        auth.username = Some("admin".into());
        assert_eq!(classify_auth(&auth), Interactive);
        auth.password = Some("secret".to_string().into());
        assert_eq!(classify_auth(&auth), NonInteractive);
    }

    #[test]
    fn command_basename_strips_directories_and_extensions() {
        assert_eq!(command_basename("aws"), "aws");
        assert_eq!(command_basename("/usr/local/bin/aws"), "aws");
        assert_eq!(command_basename(r"C:\bin\kubelogin.exe"), "kubelogin");
        assert_eq!(command_basename(r"C:\gcloud\bin\gcloud.CMD"), "gcloud");
        assert_eq!(command_basename("./bin/tsh"), "tsh");
        assert_eq!(command_basename("plugin.sh"), "plugin.sh");
        assert_eq!(command_basename(".exe"), ".exe");
        assert_eq!(command_basename(""), "");
    }

    #[test]
    fn serializes_camel_case() {
        assert_eq!(serde_json::to_string(&NonInteractive).unwrap(), "\"nonInteractive\"");
        assert_eq!(serde_json::to_string(&Interactive).unwrap(), "\"interactive\"");
        assert_eq!(serde_json::to_string(&Unknown).unwrap(), "\"unknown\"");
        assert_eq!(
            serde_json::from_str::<InteractiveClass>("\"nonInteractive\"").unwrap(),
            NonInteractive
        );
    }
}
