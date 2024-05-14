// Copyright 2022 Daniel Mikusa

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//     http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
mod parsers;

use chrono::prelude::*;
use nom::error::{self, VerboseError};
use nom::Finish;
use parsers::compound;
use serde::Serialize;
use std::net::IpAddr;
use std::str::FromStr;
use thiserror::Error;
use http::*;

#[derive(Debug, Serialize)]
pub struct CommonLogEntry<'a> {
    pub ip: IpAddr,
    pub identd_user: Option<&'a str>,
    pub user: Option<&'a str>,
    pub timestamp: DateTime<FixedOffset>,
    #[serde(skip)]
    pub request: RequestResult<'a>,
    #[serde(with = "http_serde::status_code")]
    pub status_code: StatusCode,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct CombinedLogEntry<'a> {
    pub ip: IpAddr,
    pub identd_user: Option<&'a str>,
    pub user: Option<&'a str>,
    pub timestamp: DateTime<FixedOffset>,
    #[serde(skip)]
    pub request: RequestResult<'a>,
    #[serde(with = "http_serde::status_code")]
    pub status_code: http::StatusCode,
    pub bytes: u64,
    #[serde(with = "http_serde::option::uri")]
    pub referrer: Option<http::Uri>,
    pub user_agent: Option<&'a str>,
}

#[derive(Debug, Serialize)]
pub struct CloudControllerLogEntry<'a> {
    pub request_host: &'a str,
    pub timestamp: DateTime<FixedOffset>,
    #[serde(skip)]
    pub request: RequestResult<'a>,
    #[serde(with = "http_serde::status_code")]
    pub status_code: http::StatusCode,
    pub bytes: u64,
    #[serde(with = "http_serde::option::uri")]
    pub referrer: Option<http::Uri>,
    pub user_agent: Option<&'a str>,
    pub x_forwarded_for: Vec<IpAddr>,
    pub vcap_request_id: Option<&'a str>,
    pub response_time: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct GorouterLogEntry<'a> {
    pub request_host: &'a str,
    pub timestamp: DateTime<FixedOffset>,
    #[serde(skip)]
    pub request: RequestResult<'a>,
    #[serde(with = "http_serde::status_code")]
    pub status_code: http::StatusCode,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    #[serde(with = "http_serde::option::uri")]
    pub referrer: Option<http::Uri>,
    pub user_agent: Option<&'a str>,
    pub remote_addr: IpAddr,
    pub remote_port: u16,
    pub backend_addr: Option<IpAddr>,
    pub backend_port: Option<u16>,
    pub x_forwarded_for: Vec<IpAddr>,
    pub x_forwarded_proto: XForwardedProto,
    pub vcap_request_id: Option<&'a str>,
    pub response_time: Option<f64>,
    pub gorouter_time: Option<f64>,
    pub app_id: Option<&'a str>,
    pub app_index: Option<u16>,
    pub instance_id: Option<&'a str>,
    pub x_cf_routererror: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub span_id: Option<&'a str>,
    pub parent_span_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
pub enum RequestResult<'a> {
    #[serde(skip)]
    Valid(http::Request<()>),
    
    #[serde(skip)]
    InvalidPath(&'a str, http::Error),
    InvalidRequest(&'a str),
}

#[derive(Debug, Serialize)]
pub enum LogEntry<'a> {
    CommonLog(CommonLogEntry<'a>),
    CombinedLog(CombinedLogEntry<'a>),
    GorouterLog(GorouterLogEntry<'a>),
    CloudControllerLog(CloudControllerLogEntry<'a>),
}

#[derive(Debug, Copy, Clone)]
pub enum LogType {
    CommonLog,
    CombinedLog,
    GorouterLog,
    CloudControllerLog,
}

impl FromStr for LogType {
    type Err = &'static str;

    fn from_str(s: &str) -> core::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "common" => Ok(LogType::CommonLog),
            "combined" => Ok(LogType::CombinedLog),
            "gorouter" | "router" => Ok(LogType::GorouterLog),
            "cloud_controller" | "cc" | "capi" => Ok(LogType::CloudControllerLog),
            _ => Err("invalid log type"),
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
pub enum XForwardedProto {
    HTTP,
    HTTPS,
    UNSPECIFIED,
}

impl Default for XForwardedProto {
    fn default() -> Self {
        XForwardedProto::HTTP
    }
}

/// AccessLogError enumerates all possible errors returned by this library
#[derive(Error, Debug, PartialEq)]
pub enum AccessLogError {
    #[error("Parse error")]
    ParseError { msg: String },
}

pub fn parse(log_type: LogType, line: &str) -> core::result::Result<LogEntry, AccessLogError> {
    Ok(match log_type {
        LogType::CommonLog => LogEntry::CommonLog(
            compound::common_log::<VerboseError<&str>>(line)
                .finish()
                .map_err(|e| AccessLogError::ParseError {
                    msg: error::convert_error(line, e),
                })?
                .1,
        ),
        LogType::CombinedLog => LogEntry::CombinedLog(
            compound::combined_log::<VerboseError<&str>>(line)
                .finish()
                .map_err(|e| AccessLogError::ParseError {
                    msg: error::convert_error(line, e),
                })?
                .1,
        ),
        LogType::CloudControllerLog => LogEntry::CloudControllerLog(
            compound::cloud_controller_log::<VerboseError<&str>>(line)
                .finish()
                .map_err(|e| AccessLogError::ParseError {
                    msg: error::convert_error(line, e),
                })?
                .1,
        ),
        LogType::GorouterLog => LogEntry::GorouterLog(
            compound::gorouter_log::<VerboseError<&str>>(line)
                .finish()
                .map_err(|e| AccessLogError::ParseError {
                    msg: error::convert_error(line, e),
                })?
                .1,
        ),
    })
}

#[cfg(test)]
mod tests {
    use crate::{parse, AccessLogError, LogType};

    #[test]
    fn parse_common_log() {
        let entry = parse(
            LogType::CommonLog,
            r#"127.0.0.1 - - [15/Mar/2019:03:17:05 +0000] "GET / HTTP/1.1" 200 612"#,
        );
        assert!(entry.is_ok(), "{}", entry.err().unwrap());
    }

    #[test]
    fn parse_combined_log() {
        let entry = parse(
            LogType::CombinedLog,
            r#"127.0.0.1 - - [15/Mar/2019:03:17:05 +0000] "GET / HTTP/1.1" 200 612 "http://www.example.com/foo" "foo user agent""#,
        );
        assert!(entry.is_ok(), "{}", entry.err().unwrap());
    }

    #[test]
    fn parse_cloud_controller() {
        let entry = parse(
            LogType::CloudControllerLog,
            r#"api.system_domain.local - [01/Feb/2019:20:45:02 +0000] "GET /v2/spaces/a91c3fa8-e67d-40dd-9d6b-d01aefe5062a/summary HTTP/1.1" 200 53188 "-" "cf_exporter/" 172.26.28.115, 172.26.31.254, 172.26.30.2 vcap_request_id:49d47ebe-a54f-4f84-66a7-f1262800588b::67ee0d7f-08bd-401f-a46c-24d7501a5f92 response_time:0.252"#,
        );
        assert!(entry.is_ok(), "{}", entry.err().unwrap());
    }

    #[test]
    fn parse_gorouter() {
        let entry = parse(
            LogType::GorouterLog,
            r#"test.app_domain.example.com - [2019-01-28T22:15:08.622+0000] "PUT /eureka/apps/SERVICE-REGISTRY/service-registry:-1532850760?status=UP&lastDirtyTimestamp=1547950465746 HTTP/1.1" 404 0 116 "-" "Java-EurekaClient/v1.7.0" "10.224.20.205:23150" "-" x_forwarded_for:"10.179.113.63" x_forwarded_proto:"https" vcap_request_id:"762147e9-ecb8-41b2-4acd-2adc68122486" response_time:0.000119524 app_id:"-" app_index:"-" x_b3_traceid:"59ece3a70be6b6db" x_b3_spanid:"59ece3a70be6b6db" x_b3_parentspanid:"-""#,
        );
        assert!(entry.is_ok(), "{}", entry.err().unwrap());
    }

    #[test]
    fn parse_error() {
        let entry = parse(LogType::CommonLog, "foo bar");
        assert!(entry.is_err());
        assert_eq!(
            entry.unwrap_err(),
            AccessLogError::ParseError { msg: "0: at line 1, in MapRes:\nfoo bar\n^\n\n1: at line 1, in ip:\nfoo bar\n^\n\n2: at line 1, in common_log:\nfoo bar\n^\n\n".into() }
        );
    }
}
