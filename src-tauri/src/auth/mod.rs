//! Authentication of cluster connections.
//!
//! For now this only holds the static classification of kubeconfig auth
//! configurations (`classify`), which gates background work such as the
//! clusters hub's status probe: nothing that runs in the background may ever
//! start an interactive login (a browser window, a device code, ...).

pub mod classify;
