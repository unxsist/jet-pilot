//! Names in the managed kubeconfig: internal cluster/user names
//! `jetpilot-<clusterId>`, and human context names that never collide with
//! a context in any loaded kubeconfig (`-2`, `-3`, ... suffixes).

use std::collections::HashSet;

use super::error::AppError;

pub const INTERNAL_PREFIX: &str = "jetpilot-";
const MAX_NAME_CHARS: usize = 253;

/// A random 12-character base32 id (imported and manual clusters).
pub fn new_cluster_id() -> String {
    jp_auth_core::fsutil::random_id()
}

/// The cluster and user name of a managed entry.
pub fn internal_name(cluster_id: &str) -> String {
    format!("{INTERNAL_PREFIX}{cluster_id}")
}

/// `desired`, or `desired-2`, `desired-3`, ... when taken.
pub fn unique_name(desired: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(desired) {
        return desired.to_string();
    }
    (2..)
        .map(|n| format!("{desired}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .expect("an unused suffix always exists")
}

/// A trimmed context name, or an `invalidInput` error for `field`.
pub fn validate_context_name(name: &str, field: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid(field, "Enter a name."));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::invalid(field, "The name is too long."));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::invalid(
            field,
            "The name contains control characters.",
        ));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names_get_numeric_suffixes() {
        let taken: HashSet<String> = ["prod", "prod-2", "dev"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(unique_name("staging", &taken), "staging");
        assert_eq!(unique_name("prod", &taken), "prod-3");
        assert_eq!(unique_name("dev", &taken), "dev-2");
    }

    #[test]
    fn ids_and_internal_names() {
        let id = new_cluster_id();
        assert_eq!(id.len(), 12);
        assert!(jp_auth_core::request::valid_cluster_id(&id));
        assert_eq!(internal_name("abc"), "jetpilot-abc");
    }

    #[test]
    fn context_names_are_validated() {
        assert_eq!(validate_context_name("  prod  ", "name").unwrap(), "prod");
        assert_eq!(
            validate_context_name(" ", "name")
                .unwrap_err()
                .field
                .as_deref(),
            Some("name")
        );
        assert!(validate_context_name("a\nb", "name").is_err());
        assert!(validate_context_name(&"x".repeat(300), "name").is_err());
    }
}
