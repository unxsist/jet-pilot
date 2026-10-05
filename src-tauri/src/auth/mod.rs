//! Authentication of cluster connections.
//!
//! - `classify`: static classification of kubeconfig auth configurations,
//!   which gates background work such as the clusters hub's status probe:
//!   nothing that runs in the background may ever start an interactive
//!   login (a browser window, a device code, ...).
//! - `broker` + `layer`: exec credential plugins run by the app (with a
//!   timeout, captured stderr, early kill on sign-in prompts) instead of
//!   kube-rs, cached per credential and injected into the API clients.
//! - `center`: auth issues (`auth://issue`), `auth://resolved`, failure
//!   detection in kubectl output, redaction.
//! - `status`: credential status per context (`auth_credential_status`).
//! - `login`: streamed interactive sign-ins (`auth_login_*`).

pub mod broker;
pub mod center;
pub mod classify;
pub mod layer;
pub mod login;
pub mod status;

/// A context, identified by its kubeconfig file ("" = the selected one) and
/// name.
pub use crate::probe::ContextRef;
