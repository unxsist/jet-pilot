//! Exporting clusters added in JET Pilot:
//! - `managed_export` writes a standalone kubeconfig (0600) with helper
//!   references, or with the credentials inline (the UI warns first);
//! - `managed_export_to_kube_config` merges helper-reference entries into
//!   `~/.kube/config` (never secrets): client-go's `config.lock`, a backup
//!   `config.jetpilot-backup-<timestamp>` first, the file mode kept, nothing
//!   removed, contexts whose name is already taken skipped.

use std::path::{Path, PathBuf};

use base64::Engine;
use kube::config::{ExecConfig, Kubeconfig};
use serde::{Deserialize, Serialize};

use jp_auth_core::credentials::{env_secret_id, static_secret_id, EnvSecrets, StaticCredential};
use jp_auth_core::request::Request;

use super::error::AppError;
use super::managed_kubeconfig::{self as managed, KubeconfigLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportMode {
    /// Users run the jetpilot-auth helper (works on this machine).
    Helper,
    /// Credentials written into the file.
    Inline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub written: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeConfigExportReport {
    pub written: usize,
    /// Contexts not exported because `~/.kube/config` already has one with
    /// that name.
    pub skipped: Vec<String>,
    /// The backup of `~/.kube/config` ("" when it didn't exist or nothing
    /// was written).
    pub backup: String,
}

/// The chosen contexts with their clusters and users.
pub(crate) fn extract(doc: &Kubeconfig, contexts: &[String]) -> Result<Kubeconfig, AppError> {
    if contexts.is_empty() {
        return Err(AppError::invalid(
            "contexts",
            "Choose at least one cluster to export.",
        ));
    }
    let mut out = managed::new_doc();
    for name in contexts {
        let named = doc
            .contexts
            .iter()
            .find(|c| &c.name == name)
            .ok_or_else(|| {
                AppError::not_found(format!("There is no cluster called \"{name}\"."))
            })?;
        if out.contexts.iter().any(|c| &c.name == name) {
            continue;
        }
        if let Some(ctx) = &named.context {
            if let Some(cluster) = doc.clusters.iter().find(|c| c.name == ctx.cluster) {
                if !out.clusters.iter().any(|c| c.name == cluster.name) {
                    out.clusters.push(cluster.clone());
                }
            }
            if let Some(user) = ctx
                .user
                .as_deref()
                .and_then(|u| doc.auth_infos.iter().find(|a| a.name == u))
            {
                if !out.auth_infos.iter().any(|a| a.name == user.name) {
                    out.auth_infos.push(user.clone());
                }
            }
        }
        out.contexts.push(named.clone());
    }
    out.current_context = out.contexts.first().map(|c| c.name.clone());
    Ok(out)
}

/// Replaces helper users with their credentials from the vault.
pub(crate) fn inline_credentials(
    doc: &mut Kubeconfig,
    secret: &dyn Fn(&str) -> Result<Option<serde_json::Value>, AppError>,
) -> Result<(), AppError> {
    let b64 = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
    for user in &mut doc.auth_infos {
        let Some(auth) = user.auth_info.as_mut() else {
            continue;
        };
        let Some(request) = auth.exec.as_ref().and_then(managed::helper_request) else {
            continue;
        };
        let missing = || {
            AppError::not_found(format!(
                "The credentials of \"{}\" are missing from the vault. Add the cluster again.",
                user.name
            ))
        };
        match request {
            Request::CredentialStatic { id } => {
                let value = secret(&static_secret_id(&id))?.ok_or_else(missing)?;
                let credential: StaticCredential = serde_json::from_value(value)
                    .map_err(|_| AppError::internal("Stored credentials are not valid."))?;
                auth.exec = None;
                auth.token = credential.token.clone().map(Into::into);
                if credential.has_client_certificate() {
                    auth.client_certificate_data =
                        credential.client_certificate_pem.as_deref().map(b64);
                    auth.client_key_data =
                        credential.client_key_pem.as_deref().map(|k| b64(k).into());
                }
            }
            Request::CredentialWrapExec { id, command, args } => {
                let value = secret(&env_secret_id(&id))?.ok_or_else(missing)?;
                let env: EnvSecrets = serde_json::from_value(value)
                    .map_err(|_| AppError::internal("Stored credentials are not valid."))?;
                let exec = auth.exec.take().unwrap_or_default();
                let mut all_env = exec.env.clone().unwrap_or_default();
                all_env.extend(env.into_iter().map(|(name, value)| {
                    [("name".to_string(), name), ("value".to_string(), value)].into()
                }));
                auth.exec = Some(ExecConfig {
                    command: Some(command),
                    args: Some(args),
                    env: Some(all_env),
                    install_hint: None,
                    ..exec
                });
            }
            _ => {}
        }
    }
    Ok(())
}

fn is_same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn user_kube_config() -> Result<PathBuf, AppError> {
    jp_auth_core::paths::kube_dir()
        .map(|dir| dir.join("config"))
        .ok_or_else(|| AppError::internal("The home directory is unknown."))
}

pub(crate) fn export_to_file(
    managed_path: &Path,
    contexts: &[String],
    mode: ExportMode,
    dest: &Path,
    kube_config: &Path,
    secret: &dyn Fn(&str) -> Result<Option<serde_json::Value>, AppError>,
) -> Result<ExportReport, AppError> {
    if !dest.is_absolute() {
        return Err(AppError::invalid("dest", "Choose where to save the file."));
    }
    if dest.parent().is_none_or(|p| !p.is_dir()) {
        return Err(AppError::invalid(
            "dest",
            "The folder to save in does not exist.",
        ));
    }
    if is_same_file(dest, managed_path) {
        return Err(AppError::invalid(
            "dest",
            "Choose another file than JET Pilot's own kubeconfig.",
        ));
    }
    if is_same_file(dest, kube_config) {
        return Err(AppError::invalid(
            "dest",
            "Use \"Export to ~/.kube/config\" to add clusters to your kubeconfig.",
        ));
    }
    let mut doc = extract(&managed::read(managed_path)?, contexts)?;
    if mode == ExportMode::Inline {
        inline_credentials(&mut doc, secret)?;
    }
    managed::write_file(dest, &managed::serialize(&doc)?, 0o600)?;
    Ok(ExportReport {
        written: doc.contexts.len(),
    })
}

/// Writes the chosen clusters to `dest` (absolute), with helper references
/// or (`inline`) with their credentials.
#[tauri::command]
pub async fn managed_export(
    contexts: Vec<String>,
    mode: ExportMode,
    dest: String,
) -> Result<ExportReport, AppError> {
    super::blocking(move || {
        export_to_file(
            &managed::managed_path(),
            &contexts,
            mode,
            Path::new(&dest),
            &user_kube_config()?,
            &crate::secrets::get,
        )
    })
    .await
}

pub(crate) fn merge_into(
    managed_path: &Path,
    contexts: &[String],
    target: &Path,
    timestamp: &str,
) -> Result<KubeConfigExportReport, AppError> {
    let exported = extract(&managed::read(managed_path)?, contexts)?;
    // Write through a symlinked ~/.kube/config to its target.
    let target = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::io(format!("{} can't be created", dir.display()), e))?;
    }
    let _lock = KubeconfigLock::acquire(&target)?;
    let original = match std::fs::read(&target) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(AppError::io(
                format!("{} can't be read", target.display()),
                e,
            ))
        }
    };
    let mut doc = match &original {
        Some(bytes) => managed::parse(&String::from_utf8_lossy(bytes)).map_err(|message| {
            AppError::io(
                format!("{} can't be read; nothing was changed", target.display()),
                message,
            )
        })?,
        None => managed::new_doc(),
    };

    let mut skipped = Vec::new();
    let mut written = 0;
    for named in &exported.contexts {
        if managed::context_names(&doc).any(|n| n == named.name) {
            skipped.push(named.name.clone());
            continue;
        }
        let Some(ctx) = &named.context else { continue };
        // Our jetpilot-* entries are (re)written; anything else is never
        // replaced.
        if let Some(cluster) = exported.clusters.iter().find(|c| c.name == ctx.cluster) {
            match doc.clusters.iter_mut().find(|c| c.name == cluster.name) {
                Some(existing) if cluster.name.starts_with(super::naming::INTERNAL_PREFIX) => {
                    *existing = cluster.clone()
                }
                Some(_) => {}
                None => doc.clusters.push(cluster.clone()),
            }
        }
        if let Some(user) = ctx
            .user
            .as_deref()
            .and_then(|u| exported.auth_infos.iter().find(|a| a.name == u))
        {
            match doc.auth_infos.iter_mut().find(|a| a.name == user.name) {
                Some(existing) if user.name.starts_with(super::naming::INTERNAL_PREFIX) => {
                    *existing = user.clone()
                }
                Some(_) => {}
                None => doc.auth_infos.push(user.clone()),
            }
        }
        doc.contexts.push(named.clone());
        written += 1;
    }
    if written == 0 {
        return Ok(KubeConfigExportReport {
            written,
            skipped,
            backup: String::new(),
        });
    }
    if doc.current_context.as_deref().is_none_or(str::is_empty) {
        doc.current_context = exported
            .contexts
            .iter()
            .find(|c| !skipped.contains(&c.name))
            .map(|c| c.name.clone());
    }
    // Helper references only: never secrets in the user's kubeconfig.
    managed::assert_no_inline_secrets(&exported)?;

    let mut mode = 0o600;
    let mut backup = String::new();
    if let Some(bytes) = &original {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target) {
                mode = meta.permissions().mode() & 0o777;
            }
        }
        let backup_path = target.with_file_name(format!(
            "{}.jetpilot-backup-{timestamp}",
            target.file_name().unwrap_or_default().to_string_lossy()
        ));
        jp_auth_core::fsutil::write_atomic(&backup_path, bytes, 0o600).map_err(|e| {
            AppError::io(
                format!("The backup {} can't be written", backup_path.display()),
                e,
            )
        })?;
        backup = backup_path.to_string_lossy().into_owned();
    }
    managed::write_file(&target, &managed::serialize(&doc)?, mode)?;
    Ok(KubeConfigExportReport {
        written,
        skipped,
        backup,
    })
}

/// Adds the chosen clusters (helper references) to `~/.kube/config`.
#[tauri::command]
pub async fn managed_export_to_kube_config(
    contexts: Vec<String>,
) -> Result<KubeConfigExportReport, AppError> {
    super::blocking(move || {
        let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        merge_into(
            &managed::managed_path(),
            &contexts,
            &user_kube_config()?,
            &timestamp,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MANAGED: &str = r#"
apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: jetpilot-aaa
  cluster: {server: "https://prod.example"}
- name: jetpilot-bbb
  cluster: {server: "https://aws.example"}
contexts:
- name: prod
  context: {cluster: jetpilot-aaa, user: jetpilot-aaa}
- name: eks
  context: {cluster: jetpilot-bbb, user: jetpilot-bbb}
users:
- name: jetpilot-aaa
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: /home/me/.kube/jet-pilot/bin/jetpilot-auth
      args: [credential, static, --id, aaa]
      interactiveMode: Never
- name: jetpilot-bbb
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: /home/me/.kube/jet-pilot/bin/jetpilot-auth
      args: [credential, wrap-exec, --id, bbb, --, /usr/bin/aws, eks, get-token]
      env: [{name: AWS_REGION, value: eu-west-1}]
"#;

    fn vault(id: &str) -> Result<Option<serde_json::Value>, AppError> {
        Ok(match id {
            "cluster:aaa:static" => Some(json!({"token": "tok-secret"})),
            "cluster:bbb:env" => Some(json!({"AWS_SECRET_ACCESS_KEY": "aws-secret"})),
            _ => None,
        })
    }

    #[test]
    fn exports_helper_references_or_inline_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let managed_path = dir.path().join("managed");
        std::fs::write(&managed_path, MANAGED).unwrap();
        let kube_config = dir.path().join("kube-config");
        let all = vec!["prod".to_string(), "eks".to_string()];

        let dest = dir.path().join("helper.yaml");
        let report = export_to_file(
            &managed_path,
            &all,
            ExportMode::Helper,
            &dest,
            &kube_config,
            &vault,
        )
        .unwrap();
        assert_eq!(report.written, 2);
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("jetpilot-auth") && !text.contains("tok-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let dest = dir.path().join("inline.yaml");
        export_to_file(
            &managed_path,
            &all,
            ExportMode::Inline,
            &dest,
            &kube_config,
            &vault,
        )
        .unwrap();
        let doc = managed::read(&dest).unwrap();
        let prod = doc
            .auth_infos
            .iter()
            .find(|u| u.name == "jetpilot-aaa")
            .unwrap()
            .auth_info
            .clone()
            .unwrap();
        assert!(prod.exec.is_none());
        use secrecy::ExposeSecret;
        assert_eq!(prod.token.unwrap().expose_secret(), "tok-secret");
        let eks = doc
            .auth_infos
            .iter()
            .find(|u| u.name == "jetpilot-bbb")
            .unwrap()
            .auth_info
            .clone()
            .unwrap();
        let exec = eks.exec.unwrap();
        assert_eq!(exec.command.as_deref(), Some("/usr/bin/aws"));
        assert_eq!(exec.args.unwrap(), vec!["eks", "get-token"]);
        assert_eq!(exec.env.unwrap().len(), 2);
        assert_eq!(
            exec.api_version.as_deref(),
            Some("client.authentication.k8s.io/v1beta1")
        );

        // Only one context; unknown ones and bad destinations fail.
        let dest = dir.path().join("one.yaml");
        export_to_file(
            &managed_path,
            &["eks".into()],
            ExportMode::Helper,
            &dest,
            &kube_config,
            &vault,
        )
        .unwrap();
        let doc = managed::read(&dest).unwrap();
        assert_eq!(doc.contexts.len(), 1);
        assert_eq!(doc.clusters.len(), 1);
        assert_eq!(doc.current_context.as_deref(), Some("eks"));
        assert!(export_to_file(
            &managed_path,
            &["nope".into()],
            ExportMode::Helper,
            &dest,
            &kube_config,
            &vault
        )
        .is_err());
        for bad in [
            Path::new("relative.yaml").to_path_buf(),
            managed_path.clone(),
            dir.path().join("no/dir/x.yaml"),
        ] {
            let err = export_to_file(
                &managed_path,
                &all,
                ExportMode::Helper,
                &bad,
                &kube_config,
                &vault,
            )
            .unwrap_err();
            assert_eq!(err.field.as_deref(), Some("dest"), "{}", bad.display());
        }
        std::fs::write(&kube_config, "").unwrap();
        let err = export_to_file(
            &managed_path,
            &all,
            ExportMode::Helper,
            &kube_config,
            &kube_config,
            &vault,
        )
        .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("dest"));

        // A missing secret fails the inline export.
        let empty = |_: &str| -> Result<Option<serde_json::Value>, AppError> { Ok(None) };
        let err = export_to_file(
            &managed_path,
            &all,
            ExportMode::Inline,
            &dir.path().join("x.yaml"),
            &kube_config,
            &empty,
        )
        .unwrap_err();
        assert_eq!(err.code, super::super::error::AppErrorCode::NotFound);
    }

    #[test]
    fn merge_into_kube_config_backs_up_and_never_removes() {
        let dir = tempfile::tempdir().unwrap();
        let managed_path = dir.path().join("managed");
        std::fs::write(&managed_path, MANAGED).unwrap();
        let target = dir.path().join("config");
        let original = "apiVersion: v1\nkind: Config\ncurrent-context: mine\nclusters:\n- name: c\n  cluster: {server: \"https://mine\"}\ncontexts:\n- name: mine\n  context: {cluster: c, user: u}\n- name: eks\n  context: {cluster: c, user: u}\nusers:\n- name: u\n  user: {token: users-own-token}\nx-custom: 1\n";
        std::fs::write(&target, original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        }

        let report = merge_into(
            &managed_path,
            &["prod".into(), "eks".into()],
            &target,
            "20261005-120000",
        )
        .unwrap();
        assert_eq!(report.written, 1);
        assert_eq!(report.skipped, vec!["eks"]);
        assert!(report
            .backup
            .ends_with("config.jetpilot-backup-20261005-120000"));
        assert_eq!(std::fs::read_to_string(&report.backup).unwrap(), original);

        let doc = managed::read(&target).unwrap();
        let names: Vec<_> = doc.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["mine", "eks", "prod"]);
        assert_eq!(doc.current_context.as_deref(), Some("mine"));
        assert!(doc.auth_infos.iter().any(|u| u.name == "u"));
        assert!(doc.other.contains_key("x-custom"));
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(
            text.contains("users-own-token"),
            "the user's own entries are kept"
        );
        assert!(!dir.path().join("config.lock").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }

        // Again: everything is skipped, nothing written, no new backup.
        let report =
            merge_into(&managed_path, &["prod".into()], &target, "20261005-120001").unwrap();
        assert_eq!(report.written, 0);
        assert_eq!(report.backup, "");

        // A held lock (another kubectl writing) is reported as a conflict.
        std::fs::write(dir.path().join("config.lock"), "").unwrap();
        let started = std::time::Instant::now();
        let err = merge_into(&managed_path, &["eks".into()], &target, "x").unwrap_err();
        assert_eq!(err.code, super::super::error::AppErrorCode::Conflict);
        assert!(started.elapsed() >= std::time::Duration::from_secs(4));
        std::fs::remove_file(dir.path().join("config.lock")).unwrap();

        // No kubeconfig yet: created, no backup.
        let fresh = dir.path().join("fresh").join("config");
        let report = merge_into(&managed_path, &["prod".into()], &fresh, "y").unwrap();
        assert_eq!((report.written, report.backup.as_str()), (1, ""));
        assert_eq!(
            managed::read(&fresh).unwrap().current_context.as_deref(),
            Some("prod")
        );
    }
}
