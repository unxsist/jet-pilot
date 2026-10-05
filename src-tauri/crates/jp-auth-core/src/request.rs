//! The helper's command line:
//!
//! ```text
//! jetpilot-auth credential static --id <clusterId>
//! jetpilot-auth credential wrap-exec --id <clusterId> -- <command> [args...]
//! jetpilot-auth credential aws-eks --connection <id> [--account <id> --role <name> | --profile <name>]
//!     --region <region> --cluster <name>
//! jetpilot-auth credential digitalocean --connection <id> --cluster <cluster-id>
//! jetpilot-auth credential exoscale --connection <id> --zone <zone> --cluster <cluster-id>
//! jetpilot-auth unlock | lock | doctor | version | help
//! ```
//!
//! The app writes these argv lists into the managed kubeconfig with
//! [`static_args`] / [`wrap_exec_args`] / [`aws_eks_args`] /
//! [`digitalocean_args`] / [`exoscale_args`] and recognises them with
//! [`parse`].

/// Exit codes of the helper.
pub mod exit {
    pub const OK: i32 = 0;
    pub const USAGE: i32 = 2;
    /// No stored credentials: sign in again in JET Pilot.
    pub const NOT_FOUND: i32 = 3;
    /// The vault is locked (or its key is unavailable).
    pub const LOCKED: i32 = 4;
    pub const OTHER: i32 = 5;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    CredentialStatic {
        id: String,
    },
    CredentialWrapExec {
        id: String,
        command: String,
        args: Vec<String>,
    },
    CredentialAwsEks(AwsEksArgs),
    CredentialDigitalocean(DigitaloceanArgs),
    CredentialExoscale(ExoscaleArgs),
    Unlock,
    Lock,
    Doctor,
    Version,
    Help,
}

/// An EKS token for a cluster of a cloud connection. SSO connections name
/// the account and role, profile connections the profile; access-key
/// connections neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsEksArgs {
    pub connection: String,
    pub account: Option<String>,
    pub role: Option<String>,
    pub profile: Option<String>,
    pub region: String,
    pub cluster: String,
}

/// A short-lived DigitalOcean Kubernetes token, minted with the API token
/// of a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigitaloceanArgs {
    pub connection: String,
    /// The cluster's UUID.
    pub cluster: String,
}

/// An Exoscale SKS client certificate, minted with the API key of a
/// connection in the cluster's zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExoscaleArgs {
    pub connection: String,
    pub zone: String,
    /// The cluster's UUID.
    pub cluster: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub const USAGE: &str = "\
Usage:
  jetpilot-auth credential static --id <cluster-id>
  jetpilot-auth credential wrap-exec --id <cluster-id> -- <command> [args...]
  jetpilot-auth credential aws-eks --connection <id> [--account <id> --role <name> | --profile <name>]
                --region <region> --cluster <name>
  jetpilot-auth credential digitalocean --connection <id> --cluster <cluster-id>
  jetpilot-auth credential exoscale --connection <id> --zone <zone> --cluster <cluster-id>
  jetpilot-auth unlock      unlock a passphrase vault for terminals (12 hours)
  jetpilot-auth lock        forget the terminal unlock
  jetpilot-auth doctor      show paths and vault status
  jetpilot-auth version

This is JET Pilot's kubectl credential helper. Clusters added in JET Pilot
reference it from ~/.kube/jet-pilot/config.";

/// Cluster ids are short and filename/argv safe: `[a-z0-9-]`, 1-64 chars.
pub fn valid_cluster_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `credential static --id <id>`.
pub fn static_args(id: &str) -> Vec<String> {
    ["credential", "static", "--id", id]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// `credential wrap-exec --id <id> -- <command> <args...>`.
pub fn wrap_exec_args(id: &str, command: &str, args: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = ["credential", "wrap-exec", "--id", id, "--", command]
        .iter()
        .map(|s| s.to_string())
        .collect();
    argv.extend(args.iter().cloned());
    argv
}

/// `credential aws-eks --connection <id> [--account <a> --role <r> |
/// --profile <p>] --region <region> --cluster <name>`.
pub fn aws_eks_args(args: &AwsEksArgs) -> Vec<String> {
    let mut argv: Vec<String> = ["credential", "aws-eks", "--connection", &args.connection]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut option = |name: &str, value: &Option<String>| {
        if let Some(value) = value {
            argv.push(name.to_string());
            argv.push(value.clone());
        }
    };
    option("--account", &args.account);
    option("--role", &args.role);
    option("--profile", &args.profile);
    argv.extend([
        "--region".to_string(),
        args.region.clone(),
        "--cluster".to_string(),
        args.cluster.clone(),
    ]);
    argv
}

/// `credential digitalocean --connection <id> --cluster <cluster-id>`.
pub fn digitalocean_args(args: &DigitaloceanArgs) -> Vec<String> {
    [
        "credential",
        "digitalocean",
        "--connection",
        &args.connection,
        "--cluster",
        &args.cluster,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// `credential exoscale --connection <id> --zone <zone> --cluster <id>`.
pub fn exoscale_args(args: &ExoscaleArgs) -> Vec<String> {
    [
        "credential",
        "exoscale",
        "--connection",
        &args.connection,
        "--zone",
        &args.zone,
        "--cluster",
        &args.cluster,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Cluster ids of the cloud APIs (UUIDs, numbers): 1-64 of
/// `[A-Za-z0-9-]`, not starting with `-`. Safe as a URL path segment.
pub fn valid_cloud_cluster_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A 12-digit AWS account id.
pub fn valid_account_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit())
}

/// IAM role / permission set names: `[A-Za-z0-9+=,.@_-]`, 1-128.
pub fn valid_role_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+=,.@_-".contains(&b))
}

/// `~/.aws` profile names (no flags, nothing odd).
pub fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.@+/:".contains(&b))
}

/// `eu-west-1`, `us-gov-west-1`, ...
pub fn valid_region(region: &str) -> bool {
    !region.is_empty()
        && region.len() <= 32
        && !region.starts_with('-')
        && region
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// EKS cluster names: 1-100 of `[A-Za-z0-9_-]`, starting alphanumeric.
pub fn valid_eks_cluster_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `--name value` / `--name=value` options, each at most once.
fn parse_options<'a>(
    options: &[String],
    names: &[&'a str],
) -> Result<std::collections::BTreeMap<&'a str, String>, UsageError> {
    let mut values = std::collections::BTreeMap::new();
    let mut i = 0;
    while i < options.len() {
        let arg = options[i].as_str();
        let (name, value) = match arg.split_once('=') {
            Some((name, value)) if names.contains(&name) => (name, value.to_string()),
            _ if names.contains(&arg) => {
                let value = options
                    .get(i + 1)
                    .ok_or_else(|| UsageError(format!("{arg} needs a value")))?
                    .clone();
                i += 1;
                (arg, value)
            }
            _ => return Err(UsageError(format!("unexpected argument '{arg}'"))),
        };
        let name = *names.iter().find(|n| **n == name).expect("known option");
        if values.insert(name, value).is_some() {
            return Err(UsageError(format!("{name} given twice")));
        }
        i += 1;
    }
    Ok(values)
}

fn connection_option(
    values: &mut std::collections::BTreeMap<&str, String>,
) -> Result<String, UsageError> {
    let connection = values
        .remove("--connection")
        .ok_or_else(|| UsageError("missing --connection".into()))?;
    if !valid_cluster_id(&connection) {
        return Err(UsageError(format!("invalid connection id '{connection}'")));
    }
    Ok(connection)
}

fn cloud_cluster_option(
    values: &mut std::collections::BTreeMap<&str, String>,
) -> Result<String, UsageError> {
    let cluster = values
        .remove("--cluster")
        .ok_or_else(|| UsageError("missing --cluster".into()))?;
    if !valid_cloud_cluster_id(&cluster) {
        return Err(UsageError(format!("invalid cluster id '{cluster}'")));
    }
    Ok(cluster)
}

fn parse_digitalocean(
    options: &[String],
    trailing: Option<&[String]>,
) -> Result<Request, UsageError> {
    if trailing.is_some() {
        return Err(UsageError(
            "credential digitalocean takes no command".into(),
        ));
    }
    let mut values = parse_options(options, &["--connection", "--cluster"])?;
    let connection = connection_option(&mut values)?;
    let cluster = cloud_cluster_option(&mut values)?;
    Ok(Request::CredentialDigitalocean(DigitaloceanArgs {
        connection,
        cluster,
    }))
}

fn parse_exoscale(options: &[String], trailing: Option<&[String]>) -> Result<Request, UsageError> {
    if trailing.is_some() {
        return Err(UsageError("credential exoscale takes no command".into()));
    }
    let mut values = parse_options(options, &["--connection", "--zone", "--cluster"])?;
    let connection = connection_option(&mut values)?;
    let zone = values
        .remove("--zone")
        .ok_or_else(|| UsageError("missing --zone".into()))?;
    if !valid_region(&zone) {
        return Err(UsageError(format!("invalid zone '{zone}'")));
    }
    let cluster = cloud_cluster_option(&mut values)?;
    Ok(Request::CredentialExoscale(ExoscaleArgs {
        connection,
        zone,
        cluster,
    }))
}

fn parse_aws_eks(options: &[String], trailing: Option<&[String]>) -> Result<Request, UsageError> {
    if trailing.is_some() {
        return Err(UsageError("credential aws-eks takes no command".into()));
    }
    let mut values = parse_options(
        options,
        &[
            "--connection",
            "--account",
            "--role",
            "--profile",
            "--region",
            "--cluster",
        ],
    )?;
    let mut take = |name: &str| values.remove(name);
    let connection =
        take("--connection").ok_or_else(|| UsageError("missing --connection".into()))?;
    if !valid_cluster_id(&connection) {
        return Err(UsageError(format!("invalid connection id '{connection}'")));
    }
    let account = take("--account");
    let role = take("--role");
    let profile = take("--profile");
    let region = take("--region").ok_or_else(|| UsageError("missing --region".into()))?;
    let cluster = take("--cluster").ok_or_else(|| UsageError("missing --cluster".into()))?;
    if account.is_some() != role.is_some() {
        return Err(UsageError("--account and --role go together".into()));
    }
    if profile.is_some() && account.is_some() {
        return Err(UsageError(
            "--profile can't be combined with --account / --role".into(),
        ));
    }
    if account.as_deref().is_some_and(|a| !valid_account_id(a)) {
        return Err(UsageError("invalid --account (12 digits)".into()));
    }
    if role.as_deref().is_some_and(|r| !valid_role_name(r)) {
        return Err(UsageError("invalid --role".into()));
    }
    if profile.as_deref().is_some_and(|p| !valid_profile_name(p)) {
        return Err(UsageError("invalid --profile".into()));
    }
    if !valid_region(&region) {
        return Err(UsageError(format!("invalid region '{region}'")));
    }
    if !valid_eks_cluster_name(&cluster) {
        return Err(UsageError(format!("invalid cluster name '{cluster}'")));
    }
    Ok(Request::CredentialAwsEks(AwsEksArgs {
        connection,
        account,
        role,
        profile,
        region,
        cluster,
    }))
}

/// Parses the helper's arguments (without the program name).
pub fn parse<I, S>(args: I) -> Result<Request, UsageError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args: Vec<String> = args.into_iter().map(Into::into).collect();
    let Some(first) = args.first() else {
        return Err(UsageError("missing command".into()));
    };
    let rest = &args[1..];
    let no_more = |request: Request| {
        if rest.is_empty() {
            Ok(request)
        } else {
            Err(UsageError(format!("unexpected argument '{}'", rest[0])))
        }
    };
    match first.as_str() {
        "credential" => parse_credential(rest),
        "unlock" => no_more(Request::Unlock),
        "lock" => no_more(Request::Lock),
        "doctor" => no_more(Request::Doctor),
        "version" | "--version" | "-V" => no_more(Request::Version),
        "help" | "--help" | "-h" => Ok(Request::Help),
        other => Err(UsageError(format!("unknown command '{other}'"))),
    }
}

fn parse_credential(args: &[String]) -> Result<Request, UsageError> {
    let Some(kind) = args.first() else {
        return Err(UsageError(
            "missing credential kind (static, wrap-exec, aws-eks, digitalocean, exoscale)".into(),
        ));
    };
    let (options, trailing) = match args[1..].iter().position(|a| a == "--") {
        Some(at) => (&args[1..1 + at], Some(&args[2 + at..])),
        None => (&args[1..], None),
    };
    match kind.as_str() {
        "aws-eks" => return parse_aws_eks(options, trailing),
        "digitalocean" => return parse_digitalocean(options, trailing),
        "exoscale" => return parse_exoscale(options, trailing),
        _ => {}
    }
    let mut id = None;
    let mut i = 0;
    while i < options.len() {
        let arg = &options[i];
        if arg == "--id" {
            id = Some(
                options
                    .get(i + 1)
                    .ok_or_else(|| UsageError("--id needs a value".into()))?
                    .clone(),
            );
            i += 2;
        } else if let Some(value) = arg.strip_prefix("--id=") {
            id = Some(value.to_string());
            i += 1;
        } else {
            return Err(UsageError(format!("unexpected argument '{arg}'")));
        }
    }
    let id = id.ok_or_else(|| UsageError("missing --id".into()))?;
    if !valid_cluster_id(&id) {
        return Err(UsageError(format!("invalid cluster id '{id}'")));
    }
    match kind.as_str() {
        "static" => match trailing {
            None => Ok(Request::CredentialStatic { id }),
            Some(_) => Err(UsageError("credential static takes no command".into())),
        },
        "wrap-exec" => {
            let trailing = trailing.unwrap_or_default();
            let Some((command, args)) = trailing.split_first() else {
                return Err(UsageError("wrap-exec needs a command after --".into()));
            };
            if command.is_empty() {
                return Err(UsageError("wrap-exec needs a command after --".into()));
            }
            Ok(Request::CredentialWrapExec {
                id,
                command: command.clone(),
                args: args.to_vec(),
            })
        }
        other => Err(UsageError(format!("unknown credential kind '{other}'"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(line: &str) -> Result<Request, UsageError> {
        parse(line.split_whitespace())
    }

    #[test]
    fn parses_the_grammar() {
        assert_eq!(
            parse_str("credential static --id abc123"),
            Ok(Request::CredentialStatic {
                id: "abc123".into()
            })
        );
        assert_eq!(
            parse_str("credential static --id=abc123"),
            Ok(Request::CredentialStatic {
                id: "abc123".into()
            })
        );
        assert_eq!(
            parse_str("credential wrap-exec --id x1 -- aws eks get-token --cluster-name c -- odd"),
            Ok(Request::CredentialWrapExec {
                id: "x1".into(),
                command: "aws".into(),
                args: ["eks", "get-token", "--cluster-name", "c", "--", "odd"]
                    .map(String::from)
                    .to_vec(),
            })
        );
        assert_eq!(parse_str("unlock"), Ok(Request::Unlock));
        assert_eq!(parse_str("lock"), Ok(Request::Lock));
        assert_eq!(parse_str("doctor"), Ok(Request::Doctor));
        assert_eq!(parse_str("--version"), Ok(Request::Version));
        assert_eq!(parse_str("--help"), Ok(Request::Help));
    }

    #[test]
    fn rejects_bad_usage() {
        for line in [
            "",
            "nope",
            "credential",
            "credential static",
            "credential static --id",
            "credential static --id ABC",
            "credential static --id a/b",
            "credential static --id a --extra",
            "credential static --id a -- cmd",
            "credential wrap-exec --id a",
            "credential wrap-exec --id a --",
            "credential mystery --id a",
            "unlock now",
        ] {
            assert!(parse_str(line).is_err(), "{line:?} should fail");
        }
    }

    #[test]
    fn parses_aws_eks() {
        let sso = AwsEksArgs {
            connection: "conn1".into(),
            account: Some("123456789012".into()),
            role: Some("ReadOnly".into()),
            profile: None,
            region: "eu-west-1".into(),
            cluster: "prod".into(),
        };
        assert_eq!(
            parse(aws_eks_args(&sso)),
            Ok(Request::CredentialAwsEks(sso.clone()))
        );
        assert_eq!(
            aws_eks_args(&sso).join(" "),
            "credential aws-eks --connection conn1 --account 123456789012 --role ReadOnly --region eu-west-1 --cluster prod"
        );
        let profile = AwsEksArgs {
            account: None,
            role: None,
            profile: Some("dev-admin".into()),
            ..sso.clone()
        };
        assert_eq!(
            parse(aws_eks_args(&profile)),
            Ok(Request::CredentialAwsEks(profile))
        );
        let keys = AwsEksArgs {
            account: None,
            role: None,
            ..sso.clone()
        };
        assert_eq!(
            parse_str("credential aws-eks --connection=conn1 --region eu-west-1 --cluster=prod"),
            Ok(Request::CredentialAwsEks(keys))
        );
        for line in [
            "credential aws-eks --region eu-west-1 --cluster prod",
            "credential aws-eks --connection c --cluster prod",
            "credential aws-eks --connection c --region eu-west-1",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --account 123456789012",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --account 12345 --role r",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --profile p --account 123456789012 --role r",
            "credential aws-eks --connection c --region EU --cluster prod",
            "credential aws-eks --connection c --region eu-west-1 --cluster -prod",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --profile -x",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --cluster again",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod --id x",
            "credential aws-eks --connection c --region eu-west-1 --cluster prod -- cmd",
        ] {
            assert!(parse_str(line).is_err(), "{line:?} should fail");
        }
    }

    #[test]
    fn parses_digitalocean_and_exoscale() {
        let digitalocean = DigitaloceanArgs {
            connection: "conn1".into(),
            cluster: "bd5f5959-5e1e-4205-a714-a914373942af".into(),
        };
        assert_eq!(
            digitalocean_args(&digitalocean).join(" "),
            "credential digitalocean --connection conn1 --cluster bd5f5959-5e1e-4205-a714-a914373942af"
        );
        assert_eq!(
            parse(digitalocean_args(&digitalocean)),
            Ok(Request::CredentialDigitalocean(digitalocean))
        );
        let exoscale = ExoscaleArgs {
            connection: "conn2".into(),
            zone: "ch-gva-2".into(),
            cluster: "8a2c1b62-0000-4000-8000-000000000001".into(),
        };
        assert_eq!(
            exoscale_args(&exoscale).join(" "),
            "credential exoscale --connection conn2 --zone ch-gva-2 --cluster 8a2c1b62-0000-4000-8000-000000000001"
        );
        assert_eq!(
            parse(exoscale_args(&exoscale)),
            Ok(Request::CredentialExoscale(exoscale))
        );
        assert_eq!(
            parse_str("credential exoscale --connection=c --zone=de-fra-1 --cluster=x1"),
            Ok(Request::CredentialExoscale(ExoscaleArgs {
                connection: "c".into(),
                zone: "de-fra-1".into(),
                cluster: "x1".into(),
            }))
        );
        for line in [
            "credential digitalocean --cluster x",
            "credential digitalocean --connection c",
            "credential digitalocean --connection c --cluster ../x",
            "credential digitalocean --connection c --cluster -x",
            "credential digitalocean --connection c --cluster x --zone z",
            "credential digitalocean --connection c --cluster x -- cmd",
            "credential digitalocean --connection C! --cluster x",
            "credential exoscale --connection c --cluster x",
            "credential exoscale --connection c --zone ch-gva-2",
            "credential exoscale --connection c --zone CH/GVA --cluster x",
            "credential exoscale --connection c --zone z --cluster x --cluster y",
        ] {
            assert!(parse_str(line).is_err(), "{line:?} should fail");
        }
        assert!(valid_cloud_cluster_id("123456"));
        assert!(!valid_cloud_cluster_id(&"a".repeat(65)));
        assert!(!valid_cloud_cluster_id("a b"));
    }

    #[test]
    fn builders_round_trip() {
        assert_eq!(
            parse(static_args("q2")),
            Ok(Request::CredentialStatic { id: "q2".into() })
        );
        let args = vec!["--profile".to_string(), "dev".to_string()];
        assert_eq!(
            parse(wrap_exec_args("q2", "/usr/bin/aws", &args)),
            Ok(Request::CredentialWrapExec {
                id: "q2".into(),
                command: "/usr/bin/aws".into(),
                args,
            })
        );
    }
}
