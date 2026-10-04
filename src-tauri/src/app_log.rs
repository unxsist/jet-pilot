//! In-memory application log shown on the Logs settings page.
//!
//! Events are captured by a dedicated [`tracing_subscriber::Layer`] that reads
//! the event's level and fields directly. (The previous implementation parsed
//! the *formatted* fmt output, which stored the ANSI-colored timestamp as the
//! level and the rest of the line as the message.) The buffer is bounded so a
//! long-running session cannot grow memory without limit, and every entry gets
//! a monotonically increasing sequence number so the frontend can poll for
//! new entries only.

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::RwLock;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use crate::util;

/// Maximum number of entries kept in memory. Older entries are dropped.
pub const MAX_LOG_ENTRIES: usize = 5000;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct LogEntry {
    /// Monotonic sequence number, used by `get_logs(since)` to page.
    pub seq: u64,
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Bounded ring buffer of log entries.
#[derive(Debug)]
pub struct LogBuffer {
    entries: VecDeque<LogEntry>,
    next_seq: u64,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity.min(1024)),
            next_seq: 1,
            capacity,
        }
    }

    pub fn push(&mut self, level: &Level, target: &str, message: String) {
        let entry = LogEntry {
            seq: self.next_seq,
            timestamp: Utc::now(),
            level: level.as_str().to_lowercase(),
            target: target.to_string(),
            message,
        };
        self.next_seq += 1;
        self.entries.push_back(entry);
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
    }

    /// Entries with a sequence number greater than `since` (all when `None`).
    pub fn since(&self, since: Option<u64>) -> Vec<LogEntry> {
        let since = since.unwrap_or(0);
        // Entries are ordered by seq, so skip the old prefix with a binary
        // search instead of scanning the whole buffer every poll.
        let start = self.entries.partition_point(|entry| entry.seq <= since);
        self.entries.range(start..).cloned().collect()
    }
}

static LOGS: Lazy<RwLock<LogBuffer>> = Lazy::new(|| RwLock::new(LogBuffer::new(MAX_LOG_ENTRIES)));

/// Returns the buffered entries newer than `since`.
pub fn entries_since(since: Option<u64>) -> Vec<LogEntry> {
    util::read(&LOGS).since(since)
}

/// Collects the `message` field and any additional `key=value` fields of an
/// event into a single plain-text line.
#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: String,
}

impl MessageVisitor {
    fn finish(self) -> String {
        match (self.message.is_empty(), self.fields.is_empty()) {
            (_, true) => self.message,
            (true, false) => self.fields,
            (false, false) => format!("{} {}", self.message, self.fields),
        }
    }

    fn add_field(&mut self, field: &Field, value: std::fmt::Arguments<'_>) {
        if field.name() == "message" {
            let _ = self.message.write_fmt(value);
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}=", field.name());
            let _ = self.fields.write_fmt(value);
        }
    }
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.add_field(field, format_args!("{}", value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.add_field(field, format_args!("{:?}", value));
    }
}

/// Layer that appends every enabled event to the in-memory [`LogBuffer`].
pub struct MemoryLayer;

impl<S: Subscriber> Layer<S> for MemoryLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let metadata = event.metadata();
        util::write(&LOGS).push(metadata.level(), metadata.target(), visitor.finish());
    }
}

/// Parses a level name as used by the frontend (`trace` .. `error`).
pub fn parse_level(level: &str) -> Option<Level> {
    match level.to_lowercase().as_str() {
        "trace" => Some(Level::TRACE),
        "debug" => Some(Level::DEBUG),
        "info" => Some(Level::INFO),
        "warn" => Some(Level::WARN),
        "error" => Some(Level::ERROR),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;

    #[test]
    fn buffer_is_capped_and_pages_by_seq() {
        let mut buffer = LogBuffer::new(3);
        for i in 0..5 {
            buffer.push(&Level::INFO, "test", format!("message {i}"));
        }

        let all = buffer.since(None);
        assert_eq!(all.len(), 3);
        assert_eq!(all.first().map(|e| e.seq), Some(3));
        assert_eq!(all.last().map(|e| e.message.as_str()), Some("message 4"));

        let newer = buffer.since(Some(4));
        assert_eq!(newer.len(), 1);
        assert_eq!(newer[0].seq, 5);

        assert!(buffer.since(Some(5)).is_empty());
        // A cursor older than the buffer returns everything still retained.
        assert_eq!(buffer.since(Some(1)).len(), 3);
    }

    #[test]
    fn parse_level_accepts_known_levels_case_insensitively() {
        assert_eq!(parse_level("WARN"), Some(Level::WARN));
        assert_eq!(parse_level("debug"), Some(Level::DEBUG));
        assert_eq!(parse_level("verbose"), None);
    }

    #[test]
    fn layer_captures_level_and_message_without_ansi() {
        let subscriber = tracing_subscriber::registry().with(MemoryLayer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(context = "prod", "layer test {}", 42);
        });

        let entry = entries_since(None)
            .into_iter()
            .rev()
            .find(|e| e.message.starts_with("layer test"))
            .expect("event captured");
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.message, "layer test 42 context=prod");
        assert!(!entry.message.contains('\u{1b}'));
    }
}
