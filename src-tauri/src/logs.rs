pub mod structured_logging {
    use access_log_parser::{LogEntry, LogType};
    use serde_json::{json, Value};
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use uuid::Uuid;
    use tracing::{info, warn, error};

    static STRUCTURED_LOGGING_SESSIONS: Mutex<Option<HashMap<String, StructuredLoggingSession>>> =
        Mutex::new(None);

    #[derive(Debug)]
    pub struct StructuredLoggingSession {
        entries: Vec<StructuredLogEntry>,
        columns: Vec<String>,
        facets: Vec<Facet>,
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub struct StructuredLogEntry {
        id: Uuid,
        content: String,
        timestamp: String,
        data: serde_json::Value,
    }

    #[derive(Clone, Debug, serde::Serialize)]
    pub enum MatchType {
        AND,
        OR,
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
        total: u32,
    }

    #[derive(Clone, Debug, serde::Deserialize)]
    pub struct SortingState {
        id: String,
        desc: bool,
    }

    #[tauri::command]
    pub async fn start_structured_logging_session(initial_data: Vec<String>) -> String {
        info!("Starting structured logging session");
        let session_id = Uuid::new_v4().to_string();

        if STRUCTURED_LOGGING_SESSIONS.lock().unwrap().is_none() {
            *STRUCTURED_LOGGING_SESSIONS.lock().unwrap() = Some(HashMap::new());
        }

        STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .insert(
                session_id.clone(),
                StructuredLoggingSession {
                    entries: initial_data
                        .into_iter()
                        .map(|d| StructuredLogEntry {
                            id: Uuid::new_v4(),
                            content: d.clone(),
                            timestamp: d.splitn(2, ' ').next().unwrap_or("").to_string(),
                            data: serde_json::from_str(d.splitn(2, ' ').nth(1).unwrap_or(""))
                                .unwrap_or_else(|_| serde_json::Value::String(d)),
                        })
                        .collect(),
                    columns: Vec::new(),
                    facets: Vec::new(),
                },
            );

        return session_id;
    }

    #[tauri::command]
    pub async fn repurpose_structured_logging_session(session_id: String) {
        info!("Repurposing structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            session.entries.clear();
        }
    }

    #[tauri::command]
    pub async fn end_structured_logging_session(session_id: String) {
        info!("Ending structured logging session: {}", session_id);
        STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .remove(&session_id);
    }

    #[derive(Debug)]
    enum ExtractedContent {
        Json(Value),
        Text(String),
    }

    fn extract_content(input: &str) -> Vec<ExtractedContent> {
        let mut extracted_content = Vec::new();
        let mut start_index = None;
        let mut brace_count = 0;
        let mut last_end_index = 0;

        for (i, c) in input.char_indices() {
            match c {
                '{' => {
                    if brace_count == 0 && i > last_end_index {
                        // Capture text before JSON
                        extracted_content
                            .push(ExtractedContent::Text(input[last_end_index..i].to_string()));
                    }
                    if start_index.is_none() {
                        start_index = Some(i);
                    }
                    brace_count += 1;
                }
                '}' => {
                    if brace_count > 0 {
                        brace_count -= 1;
                    }
                    if brace_count == 0 {
                        if let Some(start) = start_index {
                            let json_str = &input[start..=i];
                            if let Ok(value) = serde_json::from_str::<Value>(json_str) {
                                extracted_content.push(ExtractedContent::Json(value));
                            }
                            last_end_index = i + 1;
                            start_index = None; // Reset for the next potential JSON object
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

    #[tauri::command]
    pub async fn add_data_to_structured_logging_session(session_id: String, data: String) {
        info!("Adding data to structured logging session: {}", session_id);
        // split the data by newline if there's any
        let data = data.split("\n").collect::<Vec<&str>>();

        let parsed_records = data
            .into_iter()
            .flat_map(|d| {
                let timestamp = d.splitn(2, ' ').next().unwrap_or("");
                let data = d.splitn(2, ' ').nth(1).unwrap_or("");
                extract_content(data)
                    .into_iter()
                    .filter_map(|content| match content {
                        ExtractedContent::Json(json) => {
                            update_columns_for_logging_session(session_id.clone(), &json);
                            Some(StructuredLogEntry {
                                id: Uuid::new_v4(),
                                content: data.to_string(),
                                timestamp: timestamp.to_string(),
                                data: json,
                            })
                        }
                        ExtractedContent::Text(text) => {
                            let log_record = parse_log_record(session_id.clone(), &text);
                            Some(StructuredLogEntry {
                                id: Uuid::new_v4(),
                                content: data.to_string(),
                                timestamp: timestamp.to_string(),
                                data: log_record,
                            })
                        }
                    })
            })
            .collect::<Vec<StructuredLogEntry>>();

        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            session.entries.extend(parsed_records);
        }

        update_unique_facet_values_for_logging_session(session_id);
    }

    fn parse_log_record(session_id: String, data: &str) -> serde_json::Value {
        match serde_json::from_str(data) {
            Ok(json) => {
                update_columns_for_logging_session(session_id, &json);
                return json;
            }
            Err(_) => {}
        }

        match access_log_parser::parse(LogType::CommonLog, data) {
            Ok(clf_record) => match clf_record {
                LogEntry::CommonLog(entry) => {
                    let clf_json = serde_json::to_string(&entry);

                    match clf_json {
                        Ok(json) => {
                            update_columns_for_logging_session(
                                session_id,
                                &serde_json::from_str(&json).unwrap(),
                            );
                            return serde_json::from_str(&json).unwrap();
                        }
                        Err(_) => {}
                    }
                }
                _ => {}
            },
            Err(_) => {}
        }

        match access_log_parser::parse(LogType::CombinedLog, data) {
            Ok(cl_record) => match cl_record {
                LogEntry::CombinedLog(entry) => {
                    let cl_json = serde_json::to_string(&entry);

                    match cl_json {
                        Ok(json) => {
                            update_columns_for_logging_session(
                                session_id,
                                &serde_json::from_str(&json).unwrap(),
                            );
                            return serde_json::from_str(&json).unwrap();
                        }
                        Err(_) => {}
                    }
                }
                _ => {}
            },
            Err(_) => {}
        }

        match access_log_parser::parse(LogType::GorouterLog, data) {
            Ok(grl_record) => match grl_record {
                LogEntry::GorouterLog(entry) => {
                    let grl_json = serde_json::to_string(&entry);

                    match grl_json {
                        Ok(json) => {
                            update_columns_for_logging_session(
                                session_id,
                                &serde_json::from_str(&json).unwrap(),
                            );
                            return serde_json::from_str(&json).unwrap();
                        }
                        Err(_) => {}
                    }
                }
                _ => {}
            },
            Err(_) => {}
        }

        match access_log_parser::parse(LogType::CloudControllerLog, data) {
            Ok(ccl_record) => match ccl_record {
                LogEntry::CloudControllerLog(entry) => {
                    let ccl_json = serde_json::to_string(&entry);

                    match ccl_json {
                        Ok(json) => {
                            update_columns_for_logging_session(
                                session_id,
                                &serde_json::from_str(&json).unwrap(),
                            );
                            return serde_json::from_str(&json).unwrap();
                        }
                        Err(_) => {}
                    }
                }
                _ => {}
            },
            Err(_) => {}
        }

        return json!({ "message": data });
    }

    fn update_columns_for_logging_session(session_id: String, record: &serde_json::Value) {
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            if let Some(obj) = record.as_object() {
                for key in obj.keys() {
                    if !session.columns.contains(key) {
                        session.columns.push(key.clone());
                    }
                }
            }
        }
    }

    #[tauri::command]
    pub async fn add_facet_to_structured_logging_session(
        session_id: String,
        property: String,
        match_type: String,
    ) {
        info!("Adding facet to structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            let match_type = match match_type.as_str() {
                "AND" => MatchType::AND,
                "OR" => MatchType::OR,
                _ => MatchType::OR,
            };
            session.facets.push(Facet {
                property,
                match_type: match_type,
                values: Vec::new(),
            });
        }

        update_unique_facet_values_for_logging_session(session_id);
    }

    #[tauri::command]
    pub async fn set_facet_match_type_for_structured_logging_session(
        session_id: String,
        property: String,
        match_type: String,
    ) {
        info!("Setting facet match type for structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            for facet in session.facets.iter_mut() {
                if facet.property == property {
                    facet.match_type = match match_type.as_str() {
                        "AND" => MatchType::AND,
                        "OR" => MatchType::OR,
                        _ => MatchType::OR,
                    };
                    break;
                }
            }
        }
    }

    #[tauri::command]
    pub async fn remove_facet_from_structured_logging_session(
        session_id: String,
        property: String,
    ) {
        info!("Removing facet from structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            session.facets.retain(|f| f.property != property);
        }

        update_unique_facet_values_for_logging_session(session_id);
    }

    #[tauri::command]
    pub async fn set_filtered_for_facet_value(
        session_id: String,
        property: String,
        value: String,
        filtered: bool,
    ) {
        info!("Setting filtered for facet value in structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            for facet in session.facets.iter_mut() {
                if facet.property == property {
                    for facet_value in facet.values.iter_mut() {
                        if facet_value.value == value {
                            facet_value.filtered = filtered;
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }

    #[tauri::command]
    pub async fn get_facets_for_structured_logging_session(session_id: String) -> Vec<Facet> {
        info!("Getting facets for structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            return session.facets.clone();
        }

        return Vec::new();
    }

    #[tauri::command]
    pub async fn get_columns_for_structured_logging_session(session_id: String) -> Vec<String> {
        info!("Getting columns for structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            return session.columns.clone();
        }

        return Vec::new();
    }

    #[tauri::command]
    pub async fn get_filtered_data_for_structured_logging_session(
        session_id: String,
        search_query: String,
        mut sorting: Vec<SortingState>,
    ) -> FilteredLogResult {
        info!("Getting filtered data for structured logging session: {}", session_id);
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            let mut filtered_data = Vec::new();
            let mut any_filtered = false;
            let mut facet_matches: Vec<HashMap<String, HashSet<usize>>> = Vec::new();

            // Collect all matching rows for each filtered facet value
            for facet in session.facets.iter() {
                let mut facet_matched_indices: HashSet<usize> = HashSet::new();

                for facet_value in facet.values.iter() {
                    if facet_value.filtered {
                        any_filtered = true;
                        for (index, entry) in session.entries.iter().enumerate() {
                            if let Some(value) = entry.data.get(&facet.property) {
                                let key = serde_json::to_string(value).unwrap();
                                if key.as_str() == &facet_value.value {
                                    facet_matched_indices.insert(index);
                                }
                            }
                        }
                    }
                }

                if !facet_matched_indices.is_empty() {
                    facet_matches.push(HashMap::from([(
                        facet.property.clone(),
                        facet_matched_indices,
                    )]));
                }
            }

            let mut matched_indices = HashSet::new();

            if !facet_matches.is_empty() {
                // matched indices based on AND or OR
                matched_indices = facet_matches[0]
                    .iter()
                    .map(|(_, indices)| indices.clone())
                    .flatten()
                    .collect();
                for (property, indices) in facet_matches.iter().skip(1).flat_map(|m| m.iter()) {
                    // get matchtype for property
                    let facet = session
                        .facets
                        .iter()
                        .find(|f| f.property == *property)
                        .unwrap();
                    match facet.match_type {
                        MatchType::OR => {
                            matched_indices = matched_indices.union(indices).cloned().collect();
                        }
                        MatchType::AND => {
                            matched_indices =
                                matched_indices.intersection(indices).cloned().collect();
                        }
                    }
                }
            }

            // Collect the filtered data based on matched indices if any filters are applied
            if any_filtered {
                // Apply search query if any and filter the matched indices
                if !search_query.is_empty() {
                    let search_query = search_query.to_lowercase();
                    matched_indices = matched_indices
                        .into_iter()
                        .filter(|index| {
                            let data = &session.entries[*index];

                            if data.content.to_lowercase().contains(&search_query) {
                                return true;
                            }

                            return false;
                        })
                        .collect();
                }

                for index in matched_indices.iter() {
                    filtered_data.push(session.entries[*index].clone());
                }
            } else {
                // if any search query, apply query and then return data within offset and limit, otherwise return all data within offset and limit
                if !search_query.is_empty() {
                    let search_query = search_query.to_lowercase();
                    for (_index, entry) in session.entries.iter().enumerate() {
                        if entry.content.to_lowercase().contains(&search_query) {
                            filtered_data.push(entry.clone());
                            continue;
                        }
                    }
                } else {
                    for (_index, entry) in session.entries.iter().enumerate() {
                        filtered_data.push(entry.clone());
                    }
                }
            }

            // Apply sorting, default to timestamp
            if sorting.is_empty() {
                sorting.push(SortingState {
                    id: "timestamp".to_string(),
                    desc: false,
                });
            }

            let sorted_data = apply_sorting(filtered_data, &sorting);

            let total_count = session.entries.len() as u32;

            return FilteredLogResult {
                entries: sorted_data,
                total: total_count,
            };
        }

        return FilteredLogResult {
            entries: Vec::new(),
            total: 0,
        };
    }

    fn apply_sorting(
        mut data: Vec<StructuredLogEntry>,
        sorting: &[SortingState],
    ) -> Vec<StructuredLogEntry> {
        data.sort_by(|a, b| {
            for sort in sorting.iter() {
                let key = &sort.id;
                let desc = sort.desc;
                let value_a = a.data.get(key);
                let value_b = b.data.get(key);

                if value_a.is_none() || value_b.is_none() {
                    continue;
                }

                let order = match (value_a, value_b) {
                    (Some(va), Some(vb)) if va.is_string() && vb.is_string() => {
                        let va = va.as_str().unwrap();
                        let vb = vb.as_str().unwrap();
                        if desc {
                            vb.cmp(&va)
                        } else {
                            va.cmp(&vb)
                        }
                    }
                    (Some(va), Some(vb)) if va.is_number() && vb.is_number() => {
                        let va = va.as_f64().unwrap();
                        let vb = vb.as_f64().unwrap();
                        if desc {
                            vb.partial_cmp(&va).unwrap()
                        } else {
                            va.partial_cmp(&vb).unwrap()
                        }
                    }
                    _ => continue,
                };

                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            std::cmp::Ordering::Equal
        });
        data
    }

    fn update_unique_facet_values_for_logging_session(session_id: String) {
        if let Some(session) = STRUCTURED_LOGGING_SESSIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(&session_id)
        {
            for facet in session.facets.iter_mut() {
                let mut values: HashMap<String, u32> = HashMap::new();
                for entry in session.entries.iter() {
                    if let Some(value) = entry.data.get(&facet.property) {
                        let key = serde_json::to_string(value).unwrap();
                        *values.entry(key).or_insert(0) += 1;
                    }
                }

                for (value, total) in values.iter() {
                    if let Some(facet_value) = facet.values.iter_mut().find(|v| v.value == *value) {
                        facet_value.total = *total;
                    } else {
                        facet.values.push(FacetValue {
                            value: value.to_string(),
                            filtered: false,
                            total: *total,
                        });
                    }
                }

                // Remove any facet values that are no longer present in the data
                facet.values.retain(|v| values.contains_key(&v.value));
            }
        }
    }
}
