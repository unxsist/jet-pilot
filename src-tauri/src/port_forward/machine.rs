//! The life of a native forward: starting → ready → reconnecting (with a
//! reason) → ready again, or error. Pure transitions on the forward's info,
//! each returning the event to emit (if any), so the rules are testable
//! without a cluster.

use std::time::Duration;

use super::{ForwardStatus, PortForwardInfo, Reconnect};

pub const EVENT_READY: &str = "port_forward_ready";
pub const EVENT_RECONNECTING: &str = "port_forward_reconnecting";
pub const EVENT_UPDATED: &str = "port_forward_updated";
pub const EVENT_ERROR: &str = "port_forward_error";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// Credentials expired or were rejected.
    Auth,
    /// RBAC: no `pods/portforward` (or no read access to the target).
    Forbidden,
    /// The target object or pod doesn't exist.
    NotFound,
    /// No pod is ready (yet).
    NoReadyPod,
    /// The pod runs but nothing listens on the port.
    NotListening,
    /// The API server can't be reached, or a request broke.
    Unreachable,
    /// The cluster (or a proxy in front of it) refused the WebSocket
    /// upgrade, which kubectl handles by falling back to SPDY.
    Unsupported,
    /// The forward can't work as asked (a port the service doesn't have).
    Invalid,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub kind: FailureKind,
    pub message: String,
}

impl Failure {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Failure {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Wait (backoff) and resolve again.
    Retry,
    /// Give up: the forward goes to error.
    Fail,
    /// Hand the forward to kubectl.
    Fallback,
}

/// What to do about a failure. A forward that never became ready fails
/// fast on anything that won't fix itself, so the dialog can say why; one
/// that was ready keeps trying through everything except credentials and
/// permissions (a deleted deployment may be re-created by a rollout or
/// GitOps). `past_deadline` ends the start-up wait.
pub fn decide(status: ForwardStatus, kind: FailureKind, past_deadline: bool) -> Decision {
    use FailureKind::*;
    match (status, kind) {
        (_, Auth | Forbidden) => Decision::Fail,
        (ForwardStatus::Starting, Unsupported) => Decision::Fallback,
        (ForwardStatus::Starting, NotFound | Invalid) => Decision::Fail,
        (ForwardStatus::Starting, _) if past_deadline => Decision::Fail,
        _ => Decision::Retry,
    }
}

/// A pod is resolved and reachable. `lost` is why the previous one was
/// left (recorded as the last reconnect).
pub fn on_ready(info: &mut PortForwardInfo, pod: &str, lost: Option<&str>, now_ms: u64) -> Option<&'static str> {
    let was = info.status;
    if was == ForwardStatus::Ready && info.pod.as_deref() == Some(pod) {
        return None;
    }
    if was == ForwardStatus::Reconnecting {
        info.reconnects += 1;
        info.last_reconnect = Some(Reconnect {
            at_ms: now_ms,
            reason: lost.unwrap_or(super::resolve::LOST_BROKEN).to_string(),
        });
    }
    info.status = ForwardStatus::Ready;
    info.pod = Some(pod.to_string());
    info.reason = None;
    info.error = None;
    Some(if was == ForwardStatus::Ready { EVENT_UPDATED } else { EVENT_READY })
}

/// The pod went away (or the stream broke): reconnecting. The listener
/// stays open meanwhile.
pub fn on_lost(info: &mut PortForwardInfo, reason: &str) -> Option<&'static str> {
    if info.status != ForwardStatus::Ready {
        return None;
    }
    info.status = ForwardStatus::Reconnecting;
    info.reason = Some(capitalize(reason));
    Some(EVENT_RECONNECTING)
}

/// A retryable failure while starting or reconnecting: what it waits for.
pub fn on_waiting(info: &mut PortForwardInfo, message: &str) -> Option<&'static str> {
    if info.reason.as_deref() == Some(message) {
        return None;
    }
    info.reason = Some(message.to_string());
    Some(EVENT_UPDATED)
}

pub fn on_failed(info: &mut PortForwardInfo, message: &str) -> &'static str {
    info.status = ForwardStatus::Error;
    info.error = Some(message.to_string());
    info.reason = None;
    EVENT_ERROR
}

/// Wait before resolving again: quick at first (a rollout usually has the
/// next pod ready), then up to 30 s.
pub fn backoff(attempt: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << attempt.min(6));
    Duration::from_millis(ms.min(30_000))
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port_forward::tests::info;
    use FailureKind::*;

    #[test]
    fn start_up_fails_fast_on_what_will_not_heal() {
        let s = ForwardStatus::Starting;
        assert_eq!(decide(s, NoReadyPod, false), Decision::Retry);
        assert_eq!(decide(s, NotListening, false), Decision::Retry);
        assert_eq!(decide(s, NoReadyPod, true), Decision::Fail);
        assert_eq!(decide(s, NotFound, false), Decision::Fail);
        assert_eq!(decide(s, Invalid, false), Decision::Fail);
        assert_eq!(decide(s, Forbidden, false), Decision::Fail);
        assert_eq!(decide(s, Unsupported, false), Decision::Fallback);
    }

    #[test]
    fn a_forward_that_worked_keeps_trying() {
        let s = ForwardStatus::Reconnecting;
        assert_eq!(decide(s, NotFound, true), Decision::Retry);
        assert_eq!(decide(s, Unreachable, true), Decision::Retry);
        assert_eq!(decide(s, Unsupported, true), Decision::Retry);
        assert_eq!(decide(s, Auth, false), Decision::Fail);
        assert_eq!(decide(s, Forbidden, false), Decision::Fail);
    }

    #[test]
    fn starting_to_ready_to_reconnecting_and_back() {
        let mut pf = info();
        assert_eq!(on_waiting(&mut pf, "Waiting for a ready pod"), Some(EVENT_UPDATED));
        // The same reason again is not news.
        assert_eq!(on_waiting(&mut pf, "Waiting for a ready pod"), None);

        assert_eq!(on_ready(&mut pf, "web-a", None, 1), Some(EVENT_READY));
        assert_eq!(pf.status, ForwardStatus::Ready);
        assert_eq!(pf.reason, None);
        assert_eq!(pf.reconnects, 0);
        assert_eq!(on_ready(&mut pf, "web-a", None, 2), None);

        assert_eq!(on_lost(&mut pf, "pod was replaced"), Some(EVENT_RECONNECTING));
        assert_eq!(pf.status, ForwardStatus::Reconnecting);
        assert_eq!(pf.reason.as_deref(), Some("Pod was replaced"));
        // Only a ready forward can be lost.
        assert_eq!(on_lost(&mut pf, "pod was replaced"), None);

        assert_eq!(on_ready(&mut pf, "web-b", Some("pod was replaced"), 3), Some(EVENT_READY));
        assert_eq!(pf.pod.as_deref(), Some("web-b"));
        assert_eq!(pf.reconnects, 1);
        assert_eq!(
            pf.last_reconnect,
            Some(Reconnect {
                at_ms: 3,
                reason: "pod was replaced".into()
            })
        );
    }

    #[test]
    fn errors_record_the_message() {
        let mut pf = info();
        on_waiting(&mut pf, "Waiting");
        assert_eq!(on_failed(&mut pf, "Forbidden"), EVENT_ERROR);
        assert_eq!(pf.status, ForwardStatus::Error);
        assert_eq!(pf.error.as_deref(), Some("Forbidden"));
        assert_eq!(pf.reason, None);
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_millis(500));
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(6), Duration::from_secs(30));
        assert_eq!(backoff(40), Duration::from_secs(30));
    }
}
