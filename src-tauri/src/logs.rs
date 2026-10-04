/// Backend log streams: kubectl runs in Rust and its lines go straight into
/// a structured logging session (see `log_stream.rs`).
#[path = "log_stream.rs"]
pub mod streaming;

pub mod structured_logging {
    use access_log_parser::{LogEntry, LogType};
    use once_cell::sync::Lazy;
    use serde_json::{json, Map, Value};
    use std::cmp::Ordering;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, Mutex};
    use tracing::{debug, info, warn};
    use uuid::Uuid;

    use crate::util::lock;

    /// Maximum number of log lines kept per session. When exceeded the oldest
    /// lines are dropped (and removed from the facet counts), so a long
    /// `kubectl logs --follow` cannot grow memory without bound.
    pub const MAX_ENTRIES_PER_SESSION: usize = 20_000;

    /// Sessions are individually locked: the global map is only locked long
    /// enough to look a session up, so a slow query on one log viewer never
    /// blocks another, and a panic can't poison every session at once.
    static STRUCTURED_LOGGING_SESSIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<StructuredLoggingSession>>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    #[derive(Debug, Default)]
    pub struct StructuredLoggingSession {
        entries: VecDeque<Arc<StructuredLogEntry>>,
        next_seq: u64,
        columns: Vec<String>,
        column_set: HashSet<String>,
        facets: Vec<FacetState>,
        /// Bumped whenever a backend log stream takes over the session;
        /// batches of a superseded stream are dropped.
        pub(crate) stream_generation: u64,
    }

    /// Pseudo facet properties for the source of a line (multi-pod streams).
    /// The frontend offers them in a separate "Sources" section.
    pub const POD_FACET: &str = "@pod";
    pub const CONTAINER_FACET: &str = "@container";

    #[derive(Clone, Debug, PartialEq, serde::Serialize)]
    pub struct StructuredLogEntry {
        id: Uuid,
        /// Monotonic per-session sequence number (arrival order). Used by the
        /// frontend to fetch only new entries.
        seq: u64,
        content: String,
        /// RFC3339 in UTC with exactly 9 fractional digits when parseable, so
        /// timestamps of different pods compare correctly as strings.
        timestamp: String,
        data: Value,
        /// Pod / container the line came from (`kubectl logs --prefix`).
        pod: Option<String>,
        container: Option<String>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
    #[allow(clippy::upper_case_acronyms)]
    pub enum MatchType {
        AND,
        OR,
    }

    impl MatchType {
        fn parse(match_type: &str) -> Self {
            match match_type {
                "AND" => MatchType::AND,
                _ => MatchType::OR,
            }
        }
    }

    /// Facet state kept per session. Value counts are maintained
    /// incrementally as lines are added / evicted instead of rescanning every
    /// entry on every chunk.
    #[derive(Clone, Debug)]
    struct FacetState {
        property: String,
        match_type: MatchType,
        counts: HashMap<String, u32>,
        filtered: HashSet<String>,
    }

    impl FacetState {
        fn matches(&self, entry: &StructuredLogEntry) -> bool {
            facet_value(entry, &self.property)
                .map(|value| self.filtered.contains(&value))
                .unwrap_or(false)
        }
    }

    /// Facet key of `property` for an entry: a parsed data property, or the
    /// pod / container the line came from for the pseudo properties.
    fn facet_value(entry: &StructuredLogEntry, property: &str) -> Option<String> {
        match property {
            POD_FACET => entry.pod.as_deref().map(string_key),
            CONTAINER_FACET => entry.container.as_deref().map(string_key),
            _ => entry.data.get(property).map(facet_key),
        }
    }

    /// Same serialized form as [`facet_key`] for a string value.
    fn string_key(value: &str) -> String {
        Value::String(value.to_string()).to_string()
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub struct Facet {
        property: String,
        match_type: MatchType,
        values: Vec<FacetValue>,
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub struct FacetValue {
        value: String,
        filtered: bool,
        total: u32,
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub struct FilteredLogResult {
        entries: Vec<StructuredLogEntry>,
        /// Number of lines in the session.
        total: u32,
        /// Number of lines matching the filters / search (before paging).
        filtered_total: u32,
        /// Lowest sequence number still retained; anything older was evicted.
        oldest_seq: u64,
        /// Highest sequence number in the session (0 when empty).
        latest_seq: u64,
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub struct AddDataResult {
        /// New properties were discovered; the facet sidebar must be refreshed.
        columns_changed: bool,
        /// The session has facets, so their counts changed.
        has_facets: bool,
        total: u32,
    }

    #[derive(Clone, Debug, serde::Deserialize)]
    pub struct SortingState {
        id: String,
        desc: bool,
    }

    /// A parsed log line, before it gets a sequence number.
    #[derive(Debug, PartialEq)]
    pub(crate) struct ParsedLine {
        timestamp: String,
        content: String,
        data: Value,
        pod: Option<String>,
        container: Option<String>,
    }

    pub(crate) fn get_session(session_id: &str) -> Option<Arc<Mutex<StructuredLoggingSession>>> {
        lock(&STRUCTURED_LOGGING_SESSIONS).get(session_id).cloned()
    }

    /// Serialized form of a facet value; also what the frontend displays.
    fn facet_key(value: &Value) -> String {
        value.to_string()
    }

    impl StructuredLoggingSession {
        /// Appends parsed lines, updating columns and facet counts and
        /// evicting the oldest lines beyond [`MAX_ENTRIES_PER_SESSION`].
        /// Returns whether new columns were discovered.
        pub(crate) fn push_lines(&mut self, lines: Vec<ParsedLine>) -> bool {
            self.push_lines_capped(lines, MAX_ENTRIES_PER_SESSION)
        }

        pub(crate) fn len(&self) -> usize {
            self.entries.len()
        }

        pub(crate) fn latest_seq(&self) -> u64 {
            self.entries.back().map(|e| e.seq).unwrap_or(0)
        }

        fn push_lines_capped(&mut self, lines: Vec<ParsedLine>, capacity: usize) -> bool {
            let mut columns_changed = false;

            for line in lines {
                if let Some(object) = line.data.as_object() {
                    for key in object.keys() {
                        if self.column_set.insert(key.clone()) {
                            self.columns.push(key.clone());
                            columns_changed = true;
                        }
                    }
                }

                self.next_seq += 1;
                let entry = Arc::new(StructuredLogEntry {
                    id: Uuid::new_v4(),
                    seq: self.next_seq,
                    content: line.content,
                    timestamp: line.timestamp,
                    data: line.data,
                    pod: line.pod,
                    container: line.container,
                });

                for facet in self.facets.iter_mut() {
                    if let Some(value) = facet_value(&entry, &facet.property) {
                        *facet.counts.entry(value).or_insert(0) += 1;
                    }
                }

                self.entries.push_back(entry);
            }

            while self.entries.len() > capacity {
                if let Some(evicted) = self.entries.pop_front() {
                    self.forget_facet_values(&evicted);
                }
            }

            columns_changed
        }

        fn forget_facet_values(&mut self, entry: &StructuredLogEntry) {
            for facet in self.facets.iter_mut() {
                let Some(key) = facet_value(entry, &facet.property) else {
                    continue;
                };
                if let Some(count) = facet.counts.get_mut(&key) {
                    *count = count.saturating_sub(1);
                    // Values that no longer occur disappear from the sidebar,
                    // unless they are part of an active filter: dropping the
                    // filter silently would mix filtered and unfiltered rows
                    // in the incrementally fetched view.
                    if *count == 0 && !facet.filtered.contains(&key) {
                        facet.counts.remove(&key);
                    }
                }
            }
        }

        /// Drops every line. Active facet filters are kept (with a zero
        /// count) so clearing the view doesn't silently widen it.
        pub(crate) fn clear_entries(&mut self) {
            self.entries.clear();
            for facet in self.facets.iter_mut() {
                facet.counts.clear();
                for value in facet.filtered.iter() {
                    facet.counts.insert(value.clone(), 0);
                }
            }
        }

        fn add_facet(&mut self, property: String, match_type: MatchType) {
            if self.facets.iter().any(|f| f.property == property) {
                return;
            }

            let mut counts: HashMap<String, u32> = HashMap::new();
            for entry in self.entries.iter() {
                if let Some(value) = facet_value(entry, &property) {
                    *counts.entry(value).or_insert(0) += 1;
                }
            }

            self.facets.push(FacetState {
                property,
                match_type,
                counts,
                filtered: HashSet::new(),
            });
        }

        fn facets(&self) -> Vec<Facet> {
            self.facets
                .iter()
                .map(|facet| Facet {
                    property: facet.property.clone(),
                    match_type: facet.match_type,
                    values: facet
                        .counts
                        .iter()
                        .map(|(value, total)| FacetValue {
                            value: value.clone(),
                            filtered: facet.filtered.contains(value),
                            total: *total,
                        })
                        .collect(),
                })
                .collect()
        }
    }

    /// Snapshot of what a query needs, taken under the session lock so the
    /// filtering / sorting itself can run without holding it.
    struct QuerySnapshot {
        entries: Vec<Arc<StructuredLogEntry>>,
        active_facets: Vec<FacetState>,
        total: u32,
        oldest_seq: u64,
        latest_seq: u64,
    }

    /// Whether `entry` passes the facet filters. The first active facet
    /// seeds the result, every further facet is combined using its own match
    /// type (OR = union, AND = intersection).
    fn matches_facets(entry: &StructuredLogEntry, facets: &[FacetState]) -> bool {
        let mut iter = facets.iter();
        let Some(first) = iter.next() else {
            return true;
        };

        let mut matched = first.matches(entry);
        for facet in iter {
            matched = match facet.match_type {
                MatchType::OR => matched || facet.matches(entry),
                MatchType::AND => matched && facet.matches(entry),
            };
        }
        matched
    }

    fn matches_search(entry: &StructuredLogEntry, search_query_lower: &str) -> bool {
        search_query_lower.is_empty()
            || entry.content.to_lowercase().contains(search_query_lower)
            || entry
                .pod
                .as_deref()
                .is_some_and(|pod| pod.to_lowercase().contains(search_query_lower))
    }

    fn run_query(
        snapshot: QuerySnapshot,
        search_query: &str,
        sorting: &[SortingState],
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> FilteredLogResult {
        let search_query = search_query.to_lowercase();
        let mut matched: Vec<Arc<StructuredLogEntry>> = snapshot
            .entries
            .into_iter()
            .filter(|entry| matches_search(entry, &search_query))
            .filter(|entry| matches_facets(entry, &snapshot.active_facets))
            .collect();

        // Without explicit sorting entries stay in arrival order, which for
        // `kubectl logs --timestamps` is chronological.
        if !sorting.is_empty() {
            apply_sorting(&mut matched, sorting);
        }

        let filtered_total = matched.len() as u32;
        let offset = offset.unwrap_or(0).min(matched.len());
        let end = match limit {
            Some(limit) => offset.saturating_add(limit).min(matched.len()),
            None => matched.len(),
        };

        FilteredLogResult {
            entries: matched[offset..end].iter().map(|e| (**e).clone()).collect(),
            total: snapshot.total,
            filtered_total,
            oldest_seq: snapshot.oldest_seq,
            latest_seq: snapshot.latest_seq,
        }
    }

    /// Value used to sort an entry by the column `key`. The `timestamp` and
    /// `content` table columns map to the entry fields, anything else to a
    /// property of the parsed data.
    fn sort_value<'a>(entry: &'a StructuredLogEntry, key: &str) -> Option<SortValue<'a>> {
        match key {
            "timestamp" => Some(SortValue::Str(&entry.timestamp)),
            "content" => Some(SortValue::Str(&entry.content)),
            POD_FACET | "pod" => entry.pod.as_deref().map(SortValue::Str),
            CONTAINER_FACET | "container" => entry.container.as_deref().map(SortValue::Str),
            _ => entry.data.get(key).map(SortValue::Json),
        }
    }

    enum SortValue<'a> {
        Str(&'a str),
        Json(&'a Value),
    }

    /// Rank of a JSON type, so values of different types still compare
    /// consistently (missing < null < bool < number < string < array < object).
    fn type_rank(value: &Value) -> u8 {
        match value {
            Value::Null => 1,
            Value::Bool(_) => 2,
            Value::Number(_) => 3,
            Value::String(_) => 4,
            Value::Array(_) => 5,
            Value::Object(_) => 6,
        }
    }

    /// Total order over JSON values. The previous comparator skipped keys
    /// that were missing on either side and unwrapped `partial_cmp` on
    /// floats, which is not a total order (and `sort_by` may panic on
    /// inconsistent comparators since Rust 1.81).
    fn compare_json(a: &Value, b: &Value) -> Ordering {
        match (a, b) {
            (Value::Bool(a), Value::Bool(b)) => a.cmp(b),
            (Value::Number(a), Value::Number(b)) => {
                let a = a.as_f64().unwrap_or(0.0);
                let b = b.as_f64().unwrap_or(0.0);
                a.total_cmp(&b)
            }
            (Value::String(a), Value::String(b)) => a.cmp(b),
            (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => {
                a.to_string().cmp(&b.to_string())
            }
            _ => type_rank(a).cmp(&type_rank(b)),
        }
    }

    fn compare_sort_values(a: Option<SortValue<'_>>, b: Option<SortValue<'_>>) -> Ordering {
        match (a, b) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(SortValue::Str(a)), Some(SortValue::Str(b))) => a.cmp(b),
            (Some(SortValue::Json(a)), Some(SortValue::Json(b))) => compare_json(a, b),
            // Only one variant is produced per key, but keep the order total.
            (Some(SortValue::Str(_)), Some(SortValue::Json(_))) => Ordering::Less,
            (Some(SortValue::Json(_)), Some(SortValue::Str(_))) => Ordering::Greater,
        }
    }

    fn compare_entries(a: &StructuredLogEntry, b: &StructuredLogEntry, sorting: &[SortingState]) -> Ordering {
        for sort in sorting {
            let order = compare_sort_values(sort_value(a, &sort.id), sort_value(b, &sort.id));
            let order = if sort.desc { order.reverse() } else { order };
            if order != Ordering::Equal {
                return order;
            }
        }
        a.seq.cmp(&b.seq)
    }

    fn apply_sorting(data: &mut [Arc<StructuredLogEntry>], sorting: &[SortingState]) {
        data.sort_by(|a, b| compare_entries(a, b, sorting));
    }

    #[derive(Debug, PartialEq)]
    enum ExtractedContent {
        Json(Value),
        Text(String),
    }

    /// Splits a log line into embedded JSON objects and the text around them.
    /// Brace runs that are not valid JSON are kept as text.
    fn extract_content(input: &str) -> Vec<ExtractedContent> {
        let mut extracted_content = Vec::new();
        let mut start_index = None;
        let mut brace_count = 0usize;
        let mut last_end_index = 0;

        for (i, c) in input.char_indices() {
            match c {
                '{' => {
                    if start_index.is_none() {
                        start_index = Some(i);
                    }
                    brace_count += 1;
                }
                '}' if brace_count > 0 => {
                    brace_count -= 1;
                    if brace_count == 0 {
                        if let Some(start) = start_index.take() {
                            if let Ok(value) = serde_json::from_str::<Value>(&input[start..=i]) {
                                if start > last_end_index {
                                    extracted_content.push(ExtractedContent::Text(
                                        input[last_end_index..start].to_string(),
                                    ));
                                }
                                extracted_content.push(ExtractedContent::Json(value));
                                last_end_index = i + 1;
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Capture any remaining text after the last JSON object
        if last_end_index < input.len() {
            extracted_content.push(ExtractedContent::Text(input[last_end_index..].to_string()));
        }

        extracted_content
    }

    /// Parses one `kubectl logs --timestamps` line (`<timestamp> <message>`)
    /// into a single entry. JSON objects embedded in the message are merged
    /// into one object; surrounding text is kept as `message` when the JSON
    /// doesn't already have one. Returns `None` for blank lines.
    fn parse_line(line: &str) -> Option<ParsedLine> {
        parse_line_from(line, None, None)
    }

    /// Splits the `[pod/<pod>/<container>] ` prefix written by
    /// `kubectl logs --prefix` off a line. Returns (pod, container, rest).
    pub(crate) fn split_prefix(line: &str) -> (Option<&str>, Option<&str>, &str) {
        let Some(rest) = line.strip_prefix('[') else {
            return (None, None, line);
        };
        let Some((prefix, rest)) = rest.split_once("] ") else {
            return (None, None, line);
        };
        let mut parts = prefix.splitn(3, '/');
        match (parts.next(), parts.next(), parts.next()) {
            (Some("pod"), Some(pod), Some(container)) if !pod.is_empty() => {
                (Some(pod), Some(container), rest)
            }
            _ => (None, None, line),
        }
    }

    /// Normalizes an RFC3339 timestamp to UTC with exactly 9 fractional
    /// digits. The API server trims trailing zeros (RFC3339Nano), which makes
    /// plain string comparison wrong (`…:00.1Z` sorts after `…:00.12Z`).
    /// Anything unparseable is returned unchanged.
    pub(crate) fn normalize_timestamp(timestamp: &str) -> String {
        // Fast path: already normalized (`2024-01-01T00:00:00.123456789Z`).
        let bytes = timestamp.as_bytes();
        if bytes.len() == 30 && bytes[10] == b'T' && bytes[19] == b'.' && bytes[29] == b'Z' {
            return timestamp.to_string();
        }
        match chrono::DateTime::parse_from_rfc3339(timestamp) {
            Ok(parsed) => parsed
                .with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S%.9fZ")
                .to_string(),
            Err(_) => timestamp.to_string(),
        }
    }

    /// [`parse_line`] for a line of a known source. A `kubectl logs --prefix`
    /// prefix on the line takes precedence over the given pod / container.
    pub(crate) fn parse_line_from(
        line: &str,
        pod: Option<&str>,
        container: Option<&str>,
    ) -> Option<ParsedLine> {
        let line = line.trim_end_matches(['\r', '\n']);
        let (prefix_pod, prefix_container, line) = split_prefix(line);
        if line.trim().is_empty() {
            return None;
        }
        let pod = prefix_pod.or(pod).map(str::to_string);
        let container = prefix_container.or(container).map(str::to_string);

        let (timestamp, content) = line.split_once(' ').unwrap_or((line, ""));
        let timestamp = normalize_timestamp(timestamp);

        let mut merged: Option<Map<String, Value>> = None;
        let mut text_parts: Vec<&str> = Vec::new();
        let fragments = extract_content(content);
        for fragment in fragments.iter() {
            match fragment {
                ExtractedContent::Json(Value::Object(object)) => {
                    let target = merged.get_or_insert_with(Map::new);
                    for (key, value) in object {
                        target.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
                ExtractedContent::Json(_) => {}
                ExtractedContent::Text(text) => {
                    let text = text.trim();
                    if !text.is_empty() {
                        text_parts.push(text);
                    }
                }
            }
        }

        let data = match merged {
            Some(mut object) => {
                if !text_parts.is_empty() && !object.contains_key("message") {
                    object.insert("message".to_string(), Value::String(text_parts.join(" ")));
                }
                Value::Object(object)
            }
            None => parse_log_record(content),
        };

        Some(ParsedLine {
            timestamp,
            content: content.to_string(),
            data,
            pod,
            container,
        })
    }

    fn parse_lines(data: &str) -> Vec<ParsedLine> {
        data.split('\n').filter_map(parse_line).collect()
    }

    fn access_log_to_json<T: serde::Serialize>(entry: &T) -> Option<Value> {
        serde_json::to_value(entry).ok()
    }

    /// Parses a plain-text log message: JSON, then the common access log
    /// formats, falling back to `{ "message": <text> }`.
    fn parse_log_record(data: &str) -> Value {
        if let Ok(json) = serde_json::from_str::<Value>(data) {
            if json.is_object() {
                return json;
            }
        }

        let parsed = match access_log_parser::parse(LogType::CommonLog, data) {
            Ok(LogEntry::CommonLog(entry)) => access_log_to_json(&entry),
            _ => None,
        }
        .or_else(|| match access_log_parser::parse(LogType::CombinedLog, data) {
            Ok(LogEntry::CombinedLog(entry)) => access_log_to_json(&entry),
            _ => None,
        })
        .or_else(|| match access_log_parser::parse(LogType::GorouterLog, data) {
            Ok(LogEntry::GorouterLog(entry)) => access_log_to_json(&entry),
            _ => None,
        })
        .or_else(|| match access_log_parser::parse(LogType::CloudControllerLog, data) {
            Ok(LogEntry::CloudControllerLog(entry)) => access_log_to_json(&entry),
            _ => None,
        });

        parsed.unwrap_or_else(|| json!({ "message": data.trim() }))
    }

    /// Runs CPU-heavy work (parsing / filtering / sorting) off the async
    /// runtime's worker threads.
    pub(crate) async fn blocking<T, F>(work: F) -> T
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
        T: Default,
    {
        match tauri::async_runtime::spawn_blocking(work).await {
            Ok(result) => result,
            Err(err) => {
                warn!("Structured logging task failed: {}", err);
                T::default()
            }
        }
    }

    #[tauri::command]
    pub async fn start_structured_logging_session(initial_data: Vec<String>) -> String {
        info!("Starting structured logging session");
        let session_id = Uuid::new_v4().to_string();

        let lines = blocking(move || {
            initial_data
                .iter()
                .filter_map(|line| parse_line(line))
                .collect::<Vec<_>>()
        })
        .await;

        let mut session = StructuredLoggingSession::default();
        session.push_lines(lines);

        insert_session(session_id.clone(), session);

        session_id
    }

    pub(crate) fn insert_session(session_id: String, session: StructuredLoggingSession) {
        lock(&STRUCTURED_LOGGING_SESSIONS).insert(session_id, Arc::new(Mutex::new(session)));
    }

    #[tauri::command]
    pub async fn repurpose_structured_logging_session(session_id: String) {
        info!("Repurposing structured logging session: {}", session_id);
        if let Some(session) = get_session(&session_id) {
            lock(&session).clear_entries();
        }
    }

    #[tauri::command]
    pub async fn end_structured_logging_session(session_id: String) {
        info!("Ending structured logging session: {}", session_id);
        super::streaming::stop_stream(&session_id);
        lock(&STRUCTURED_LOGGING_SESSIONS).remove(&session_id);
    }

    #[tauri::command]
    pub async fn add_data_to_structured_logging_session(
        session_id: String,
        data: String,
    ) -> Option<AddDataResult> {
        debug!("Adding data to structured logging session: {}", session_id);
        let session = get_session(&session_id)?;

        let lines = blocking(move || parse_lines(&data)).await;

        let mut session = lock(&session);
        let columns_changed = session.push_lines(lines);
        Some(AddDataResult {
            columns_changed,
            has_facets: !session.facets.is_empty(),
            total: session.entries.len() as u32,
        })
    }

    #[tauri::command]
    pub async fn add_facet_to_structured_logging_session(
        session_id: String,
        property: String,
        match_type: String,
    ) {
        info!("Adding facet to structured logging session: {}", session_id);
        if let Some(session) = get_session(&session_id) {
            blocking(move || {
                lock(&session).add_facet(property, MatchType::parse(&match_type));
            })
            .await;
        }
    }

    #[tauri::command]
    pub async fn set_facet_match_type_for_structured_logging_session(
        session_id: String,
        property: String,
        match_type: String,
    ) {
        info!("Setting facet match type for structured logging session: {}", session_id);
        if let Some(session) = get_session(&session_id) {
            let mut session = lock(&session);
            if let Some(facet) = session.facets.iter_mut().find(|f| f.property == property) {
                facet.match_type = MatchType::parse(&match_type);
            }
        }
    }

    #[tauri::command]
    pub async fn remove_facet_from_structured_logging_session(
        session_id: String,
        property: String,
    ) {
        info!("Removing facet from structured logging session: {}", session_id);
        if let Some(session) = get_session(&session_id) {
            lock(&session).facets.retain(|f| f.property != property);
        }
    }

    #[tauri::command]
    pub async fn set_filtered_for_facet_value(
        session_id: String,
        property: String,
        value: String,
        filtered: bool,
    ) {
        info!("Setting filtered for facet value in structured logging session: {}", session_id);
        if let Some(session) = get_session(&session_id) {
            let mut session = lock(&session);
            if let Some(facet) = session.facets.iter_mut().find(|f| f.property == property) {
                if filtered {
                    if facet.counts.contains_key(&value) {
                        facet.filtered.insert(value);
                    }
                } else {
                    facet.filtered.remove(&value);
                }
            }
        }
    }

    #[tauri::command]
    pub async fn get_facets_for_structured_logging_session(session_id: String) -> Vec<Facet> {
        debug!("Getting facets for structured logging session: {}", session_id);
        get_session(&session_id)
            .map(|session| lock(&session).facets())
            .unwrap_or_default()
    }

    #[tauri::command]
    pub async fn get_columns_for_structured_logging_session(session_id: String) -> Vec<String> {
        debug!("Getting columns for structured logging session: {}", session_id);
        get_session(&session_id)
            .map(|session| lock(&session).columns.clone())
            .unwrap_or_default()
    }

    /// Returns the entries matching the facet filters and search query.
    ///
    /// - `since_seq`: only consider entries newer than this sequence number
    ///   (incremental fetch of newly arrived lines, in arrival order).
    /// - `offset` / `limit`: page through the (sorted) result.
    #[tauri::command]
    pub async fn get_filtered_data_for_structured_logging_session(
        session_id: String,
        search_query: String,
        sorting: Vec<SortingState>,
        since_seq: Option<u64>,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> FilteredLogResult {
        debug!("Getting filtered data for structured logging session: {}", session_id);
        let empty = FilteredLogResult {
            entries: Vec::new(),
            total: 0,
            filtered_total: 0,
            oldest_seq: 0,
            latest_seq: 0,
        };

        let Some(session) = get_session(&session_id) else {
            return empty;
        };

        // Only cheap Arc clones happen under the lock.
        let snapshot = {
            let session = lock(&session);
            let since = since_seq.unwrap_or(0);
            let start = session.entries.partition_point(|entry| entry.seq <= since);
            QuerySnapshot {
                entries: session.entries.range(start..).cloned().collect(),
                active_facets: session
                    .facets
                    .iter()
                    .filter(|facet| !facet.filtered.is_empty())
                    .map(|facet| FacetState {
                        property: facet.property.clone(),
                        match_type: facet.match_type,
                        counts: HashMap::new(),
                        filtered: facet.filtered.clone(),
                    })
                    .collect(),
                total: session.entries.len() as u32,
                oldest_seq: session.entries.front().map(|e| e.seq).unwrap_or(0),
                latest_seq: session.entries.back().map(|e| e.seq).unwrap_or(0),
            }
        };

        let result = tauri::async_runtime::spawn_blocking(move || {
            run_query(snapshot, &search_query, &sorting, offset, limit)
        })
        .await;

        match result {
            Ok(result) => result,
            Err(err) => {
                warn!("Structured logging query failed: {}", err);
                empty
            }
        }
    }

    /// Writes one exported line. `text`: `<timestamp> [<pod>/<container>] <content>`
    /// (the source only when known); `jsonl`: one JSON object per line.
    fn write_export_line(
        out: &mut impl std::io::Write,
        entry: &StructuredLogEntry,
        jsonl: bool,
    ) -> std::io::Result<()> {
        if jsonl {
            let record = json!({
                "timestamp": entry.timestamp,
                "pod": entry.pod,
                "container": entry.container,
                "message": entry.content,
                "data": entry.data,
            });
            return writeln!(out, "{}", record);
        }

        match (&entry.pod, &entry.container) {
            (Some(pod), Some(container)) => {
                writeln!(out, "{} [{}/{}] {}", entry.timestamp, pod, container, entry.content)
            }
            (Some(pod), None) => writeln!(out, "{} [{}] {}", entry.timestamp, pod, entry.content),
            _ => writeln!(out, "{} {}", entry.timestamp, entry.content),
        }
    }

    /// Exports the lines matching the current facet filters and
    /// `search_query` to `path` (chosen by the user in a save dialog), so
    /// the lines never have to be copied to the webview. `format` is `text`
    /// or `jsonl`. Returns the number of lines written.
    #[tauri::command]
    pub async fn export_structured_logging_session(
        session_id: String,
        path: String,
        search_query: String,
        format: String,
    ) -> Result<u32, String> {
        info!("Exporting structured logging session: {}", session_id);
        let session = get_session(&session_id).ok_or("The log session has ended")?;

        let snapshot = {
            let session = lock(&session);
            QuerySnapshot {
                entries: session.entries.iter().cloned().collect(),
                active_facets: session
                    .facets
                    .iter()
                    .filter(|facet| !facet.filtered.is_empty())
                    .cloned()
                    .collect(),
                total: session.entries.len() as u32,
                oldest_seq: 0,
                latest_seq: 0,
            }
        };

        let jsonl = format == "jsonl";
        tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
            let search_query = search_query.to_lowercase();
            let file = std::fs::File::create(&path)
                .map_err(|e| format!("Unable to create {}: {}", path, e))?;
            let mut out = std::io::BufWriter::new(file);
            let mut written = 0u32;
            for entry in snapshot.entries.iter() {
                if matches_search(entry, &search_query)
                    && matches_facets(entry, &snapshot.active_facets)
                {
                    write_export_line(&mut out, entry, jsonl)
                        .map_err(|e| format!("Unable to write {}: {}", path, e))?;
                    written += 1;
                }
            }
            std::io::Write::flush(&mut out).map_err(|e| format!("Unable to write {}: {}", path, e))?;
            Ok(written)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn entry(seq: u64, timestamp: &str, data: Value) -> Arc<StructuredLogEntry> {
            Arc::new(StructuredLogEntry {
                id: Uuid::new_v4(),
                seq,
                content: data.to_string(),
                timestamp: timestamp.to_string(),
                data,
                pod: None,
                container: None,
            })
        }

        fn sort(id: &str, desc: bool) -> Vec<SortingState> {
            vec![SortingState { id: id.to_string(), desc }]
        }

        fn line(timestamp: &str, data: Value) -> ParsedLine {
            ParsedLine {
                timestamp: timestamp.to_string(),
                content: data.to_string(),
                data,
                pod: None,
                container: None,
            }
        }

        fn sourced_line(pod: &str, container: &str, data: Value) -> ParsedLine {
            ParsedLine {
                pod: Some(pod.to_string()),
                container: Some(container.to_string()),
                ..line("t", data)
            }
        }

        #[test]
        fn prefix_is_split_into_pod_and_container() {
            assert_eq!(
                split_prefix("[pod/web-1/app] 2024-01-01T00:00:00Z hi"),
                (Some("web-1"), Some("app"), "2024-01-01T00:00:00Z hi")
            );
            // Not a kubectl prefix: kept as content.
            assert_eq!(split_prefix("[INFO] started"), (None, None, "[INFO] started"));
            assert_eq!(split_prefix("[pod/] x"), (None, None, "[pod/] x"));

            let parsed =
                parse_line_from("[pod/web-1/app] 2024-01-01T00:00:00.5Z {\"level\":\"info\"}", Some("other"), None)
                    .unwrap();
            assert_eq!(parsed.pod.as_deref(), Some("web-1"));
            assert_eq!(parsed.container.as_deref(), Some("app"));
            assert_eq!(parsed.timestamp, "2024-01-01T00:00:00.500000000Z");
            assert_eq!(parsed.data, json!({ "level": "info" }));

            // Without a prefix the given source is used.
            let parsed = parse_line_from("ts hello", Some("web-2"), Some("c")).unwrap();
            assert_eq!(parsed.pod.as_deref(), Some("web-2"));
            // A prefixed blank line is skipped.
            assert!(parse_line_from("[pod/web-1/app] ", None, None).is_none());
        }

        #[test]
        fn timestamps_are_normalized_for_string_ordering() {
            let a = normalize_timestamp("2024-01-01T00:00:00.1Z");
            let b = normalize_timestamp("2024-01-01T00:00:00.12Z");
            assert!(a < b, "{a} should sort before {b}");
            assert_eq!(normalize_timestamp("2024-01-01T02:00:00+02:00"), "2024-01-01T00:00:00.000000000Z");
            assert_eq!(normalize_timestamp("not-a-timestamp"), "not-a-timestamp");
            let already = "2024-01-01T00:00:00.123456789Z";
            assert_eq!(normalize_timestamp(already), already);
        }

        #[test]
        fn pod_and_container_facets_count_and_filter() {
            let mut session = StructuredLoggingSession::default();
            session.push_lines(vec![
                sourced_line("web-1", "app", json!({ "n": 1 })),
                sourced_line("web-2", "app", json!({ "n": 2 })),
                sourced_line("web-2", "sidecar", json!({ "n": 3 })),
            ]);
            session.add_facet(POD_FACET.to_string(), MatchType::OR);
            session.add_facet(CONTAINER_FACET.to_string(), MatchType::AND);
            assert_eq!(session.facets[0].counts.get("\"web-2\""), Some(&2));
            assert_eq!(session.facets[1].counts.get("\"app\""), Some(&2));

            session.facets[0].filtered.insert("\"web-2\"".to_string());
            session.facets[1].filtered.insert("\"app\"".to_string());
            let snapshot = QuerySnapshot {
                entries: session.entries.iter().cloned().collect(),
                active_facets: session.facets.clone(),
                total: 3,
                oldest_seq: 1,
                latest_seq: 3,
            };
            let result = run_query(snapshot, "", &[], None, None);
            let ns: Vec<Value> = result.entries.iter().map(|e| e.data["n"].clone()).collect();
            assert_eq!(ns, vec![json!(2)]);

            // Clearing keeps the active filters.
            session.clear_entries();
            assert!(session.facets[0].filtered.contains("\"web-2\""));
            assert_eq!(session.facets[0].counts.get("\"web-2\""), Some(&0));
        }

        #[test]
        fn export_lines_include_the_source() {
            let e = StructuredLogEntry {
                id: Uuid::new_v4(),
                seq: 1,
                content: "hello".to_string(),
                timestamp: "2024-01-01T00:00:00.000000000Z".to_string(),
                data: json!({ "message": "hello" }),
                pod: Some("web-1".to_string()),
                container: Some("app".to_string()),
            };
            let mut out = Vec::new();
            write_export_line(&mut out, &e, false).unwrap();
            assert_eq!(String::from_utf8(out).unwrap(), "2024-01-01T00:00:00.000000000Z [web-1/app] hello\n");

            let mut out = Vec::new();
            write_export_line(&mut out, &e, true).unwrap();
            let record: Value = serde_json::from_str(String::from_utf8(out).unwrap().trim()).unwrap();
            assert_eq!(record["pod"], json!("web-1"));
            assert_eq!(record["message"], json!("hello"));
        }

        #[test]
        fn comparator_is_total_with_missing_and_mixed_values() {
            let values = [
                json!({ "level": "info" }),
                json!({}),
                json!({ "level": 3 }),
                json!({ "level": null }),
                json!({ "level": f64::MAX }),
                json!({ "level": true }),
                json!({ "level": [1, 2] }),
                json!({ "level": { "a": 1 } }),
                json!({ "level": "debug" }),
                json!({ "level": -1.5 }),
            ];
            let mut data: Vec<_> = (0..200)
                .map(|i| entry(i, "t", values[(i as usize * 7) % values.len()].clone()))
                .collect();

            for desc in [false, true] {
                let sorting = sort("level", desc);
                apply_sorting(&mut data, &sorting);

                // Sorted output must be consistent with the comparator, and
                // the comparator must be antisymmetric and transitive.
                for pair in data.windows(2) {
                    assert_ne!(compare_entries(&pair[0], &pair[1], &sorting), Ordering::Greater);
                }
                for a in data.iter().take(20) {
                    for b in data.iter().take(20) {
                        assert_eq!(
                            compare_entries(a, b, &sorting),
                            compare_entries(b, a, &sorting).reverse()
                        );
                        for c in data.iter().take(20) {
                            if compare_entries(a, b, &sorting) == Ordering::Less
                                && compare_entries(b, c, &sorting) == Ordering::Less
                            {
                                assert_eq!(compare_entries(a, c, &sorting), Ordering::Less);
                            }
                        }
                    }
                }
            }
        }

        #[test]
        fn comparator_orders_by_type_then_value() {
            let mut data = vec![
                entry(1, "t", json!({ "v": "b" })),
                entry(2, "t", json!({ "v": 10 })),
                entry(3, "t", json!({})),
                entry(4, "t", json!({ "v": 2 })),
                entry(5, "t", json!({ "v": "a" })),
            ];
            apply_sorting(&mut data, &sort("v", false));
            let order: Vec<u64> = data.iter().map(|e| e.seq).collect();
            assert_eq!(order, vec![3, 4, 2, 5, 1]);

            apply_sorting(&mut data, &sort("v", true));
            let order: Vec<u64> = data.iter().map(|e| e.seq).collect();
            assert_eq!(order, vec![1, 5, 2, 4, 3]);
        }

        #[test]
        fn timestamp_sort_uses_entry_timestamp() {
            let mut data = vec![
                entry(1, "2024-01-01T00:00:02Z", json!({ "message": "b" })),
                entry(2, "2024-01-01T00:00:01Z", json!({ "message": "a" })),
            ];
            apply_sorting(&mut data, &sort("timestamp", false));
            assert_eq!(data[0].seq, 2);
        }

        #[test]
        fn json_line_becomes_single_entry() {
            let parsed = parse_line(r#"2024-01-01T00:00:00Z {"level":"info","msg":"hi"}"#).unwrap();
            assert_eq!(parsed.timestamp, "2024-01-01T00:00:00.000000000Z");
            assert_eq!(parsed.data, json!({ "level": "info", "msg": "hi" }));
        }

        #[test]
        fn mixed_text_and_json_line_is_one_entry() {
            let parsed =
                parse_line(r#"2024-01-01T00:00:00Z INFO request done {"status":200} {"ms":12} trailing"#)
                    .unwrap();
            assert_eq!(
                parsed.data,
                json!({ "status": 200, "ms": 12, "message": "INFO request done trailing" })
            );
            assert_eq!(
                parsed.content,
                r#"INFO request done {"status":200} {"ms":12} trailing"#
            );

            // An existing message field wins over surrounding text.
            let parsed = parse_line(r#"ts prefix {"message":"inner"}"#).unwrap();
            assert_eq!(parsed.data, json!({ "message": "inner" }));
        }

        #[test]
        fn plain_text_and_invalid_braces_are_kept() {
            let parsed = parse_line("ts hello {not json} world").unwrap();
            assert_eq!(parsed.data, json!({ "message": "hello {not json} world" }));

            assert_eq!(
                extract_content("a {bad} b {\"x\":1}"),
                vec![
                    ExtractedContent::Text("a {bad} b ".to_string()),
                    ExtractedContent::Json(json!({ "x": 1 })),
                ]
            );
        }

        #[test]
        fn blank_lines_are_skipped() {
            let lines = parse_lines("ts one\n\n   \r\nts two\r\n");
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[1].data, json!({ "message": "two" }));
        }

        #[test]
        fn facet_counts_are_incremental_and_follow_eviction() {
            let mut session = StructuredLoggingSession::default();
            session.push_lines_capped(vec![line("t", json!({ "level": "info" }))], 3);
            session.add_facet("level".to_string(), MatchType::OR);
            session.push_lines_capped(
                vec![
                    line("t", json!({ "level": "warn" })),
                    line("t", json!({ "level": "info" })),
                ],
                3,
            );

            let counts = |session: &StructuredLoggingSession| -> HashMap<String, u32> {
                session.facets[0].counts.clone()
            };
            assert_eq!(counts(&session).get("\"info\""), Some(&2));
            assert_eq!(counts(&session).get("\"warn\""), Some(&1));

            session.facets[0].filtered.insert("\"warn\"".to_string());
            // Evicts the first "info" and then the "warn" line.
            session.push_lines_capped(
                vec![
                    line("t", json!({ "level": "error" })),
                    line("t", json!({ "level": "error" })),
                ],
                3,
            );
            assert_eq!(session.entries.len(), 3);
            assert_eq!(counts(&session).get("\"info\""), Some(&1));
            // An actively filtered value is kept (count 0) instead of silently
            // dropping the filter.
            assert_eq!(counts(&session).get("\"warn\""), Some(&0));
            assert!(session.facets[0].filtered.contains("\"warn\""));
            assert_eq!(session.entries.front().map(|e| e.seq), Some(3));
        }

        #[test]
        fn query_filters_pages_and_supports_since() {
            let mut session = StructuredLoggingSession::default();
            session.push_lines(
                (0..10)
                    .map(|i| line("t", json!({ "n": i, "kind": if i % 2 == 0 { "even" } else { "odd" } })))
                    .collect(),
            );
            session.add_facet("kind".to_string(), MatchType::OR);
            session.facets[0].filtered.insert("\"even\"".to_string());

            let snapshot = |since: u64| QuerySnapshot {
                entries: session.entries.iter().filter(|e| e.seq > since).cloned().collect(),
                active_facets: session.facets.clone(),
                total: session.entries.len() as u32,
                oldest_seq: 1,
                latest_seq: 10,
            };

            let result = run_query(snapshot(0), "", &[], None, None);
            assert_eq!(result.filtered_total, 5);
            assert_eq!(result.total, 10);

            let result = run_query(snapshot(0), "", &sort("n", true), Some(1), Some(2));
            let ns: Vec<Value> = result.entries.iter().map(|e| e.data["n"].clone()).collect();
            assert_eq!(ns, vec![json!(6), json!(4)]);

            let result = run_query(snapshot(6), "", &[], None, None);
            let seqs: Vec<u64> = result.entries.iter().map(|e| e.seq).collect();
            assert_eq!(seqs, vec![7, 9]);
        }

        #[test]
        fn and_facets_intersect() {
            let facet = |property: &str, value: &str, match_type| FacetState {
                property: property.to_string(),
                match_type,
                counts: HashMap::new(),
                filtered: HashSet::from([value.to_string()]),
            };
            let e = entry(1, "t", json!({ "a": "x", "b": "y" }));
            assert!(matches_facets(&e, &[facet("a", "\"x\"", MatchType::OR), facet("b", "\"y\"", MatchType::AND)]));
            assert!(!matches_facets(&e, &[facet("a", "\"x\"", MatchType::OR), facet("b", "\"z\"", MatchType::AND)]));
            assert!(matches_facets(&e, &[facet("a", "\"q\"", MatchType::OR), facet("b", "\"y\"", MatchType::OR)]));
        }
    }
}
