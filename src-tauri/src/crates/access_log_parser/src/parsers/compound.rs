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

use std::net::AddrParseError;

use nom::{
    bytes::complete::{take_while, take_while1},
    character::complete::char,
    combinator::map,
    error::{context, ContextError, FromExternalError, ParseError},
    sequence::{terminated, tuple},
    IResult,
};

use crate::{parsers::core::ip, CombinedLogEntry, GorouterLogEntry};
use crate::{CloudControllerLogEntry, CommonLogEntry};

use super::core::{
    app_id, app_index, bytes, date, gorouter_time, http_status, idnetd_user, instance_id,
    ip_and_port, ip_list, referrer, request, response_time, user, user_agent, vcap_request_id,
    x_b3_parentspanid, x_b3_spanid, x_b3_traceid, x_cf_routererror, x_forwarded_for,
    x_forwarded_proto,
};

pub(crate) fn common_log<'a, E>(input: &'a str) -> IResult<&'a str, CommonLogEntry, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, AddrParseError>
        + FromExternalError<&'a str, chrono::ParseError>
        + FromExternalError<&'a str, http::Error>
        + FromExternalError<&'a str, http::status::InvalidStatusCode>
        + FromExternalError<&'a str, std::num::ParseIntError>,
{
    context(
        "common_log",
        map(
            tuple((
                terminated(ip, char(' ')),
                terminated(idnetd_user, char(' ')),
                terminated(user, char(' ')),
                terminated(date, char(' ')),
                terminated(request, char(' ')),
                terminated(http_status, char(' ')),
                bytes,
            )),
            |(ip, identd_user, user, timestamp, request, status_code, bytes)| CommonLogEntry {
                ip,
                identd_user,
                user,
                timestamp,
                request,
                status_code,
                bytes,
            },
        ),
    )(input)
}

pub(crate) fn combined_log<'a, E>(input: &'a str) -> IResult<&'a str, CombinedLogEntry, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, AddrParseError>
        + FromExternalError<&'a str, chrono::ParseError>
        + FromExternalError<&'a str, http::Error>
        + FromExternalError<&'a str, http::status::InvalidStatusCode>
        + FromExternalError<&'a str, std::num::ParseIntError>
        + FromExternalError<&'a str, http::uri::InvalidUri>,
{
    context(
        "combined_log",
        map(
            tuple((
                terminated(common_log, char(' ')),
                terminated(referrer, char(' ')),
                user_agent,
            )),
            |(common, referrer, user_agent)| CombinedLogEntry {
                ip: common.ip,
                identd_user: common.identd_user,
                user: common.user,
                timestamp: common.timestamp,
                request: common.request,
                status_code: common.status_code,
                bytes: common.bytes,
                referrer,
                user_agent,
            },
        ),
    )(input)
}

pub(crate) fn cloud_controller_log<'a, E>(
    input: &'a str,
) -> IResult<&'a str, CloudControllerLogEntry, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, AddrParseError>
        + FromExternalError<&'a str, chrono::ParseError>
        + FromExternalError<&'a str, http::Error>
        + FromExternalError<&'a str, http::status::InvalidStatusCode>
        + FromExternalError<&'a str, std::num::ParseIntError>
        + FromExternalError<&'a str, http::uri::InvalidUri>,
{
    context(
        "cloud_controller_log",
        map(
            tuple((
                terminated(take_while1(|c: char| !c.is_whitespace()), char(' ')),
                terminated(char('-'), char(' ')),
                terminated(date, char(' ')),
                terminated(request, char(' ')),
                terminated(http_status, char(' ')),
                terminated(bytes, char(' ')),
                terminated(referrer, char(' ')),
                terminated(user_agent, char(' ')),
                terminated(ip_list, char(' ')),
                terminated(vcap_request_id, char(' ')),
                response_time,
            )),
            |(
                request_host,
                _,
                timestamp,
                request,
                status_code,
                bytes,
                referrer,
                user_agent,
                x_forwarded_for,
                vcap_request_id,
                response_time,
            )| {
                CloudControllerLogEntry {
                    request_host,
                    timestamp,
                    request,
                    status_code,
                    bytes,
                    referrer,
                    user_agent,
                    x_forwarded_for,
                    vcap_request_id,
                    response_time,
                }
            },
        ),
    )(input)
}

pub(crate) fn gorouter_log<'a, E>(input: &'a str) -> IResult<&'a str, GorouterLogEntry, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, AddrParseError>
        + FromExternalError<&'a str, chrono::ParseError>
        + FromExternalError<&'a str, http::Error>
        + FromExternalError<&'a str, http::status::InvalidStatusCode>
        + FromExternalError<&'a str, std::num::ParseIntError>
        + FromExternalError<&'a str, http::uri::InvalidUri>,
{
    context(
        "gorouter_log",
        map(
            tuple((
                tuple((
                    terminated(take_while1(|c: char| !c.is_whitespace()), char(' ')),
                    terminated(char('-'), char(' ')),
                    terminated(date, char(' ')),
                    terminated(request, char(' ')),
                    terminated(http_status, char(' ')),
                    context("bytes received", terminated(bytes, char(' '))),
                    context("bytes sent", terminated(bytes, char(' '))),
                    terminated(referrer, char(' ')),
                    terminated(user_agent, char(' ')),
                    context("remote address", terminated(ip_and_port, char(' '))),
                    context("backend address", terminated(ip_and_port, char(' '))),
                    terminated(x_forwarded_for, char(' ')),
                    terminated(x_forwarded_proto, char(' ')),
                    terminated(vcap_request_id, char(' ')),
                    terminated(response_time, char(' ')),
                    terminated(gorouter_time, take_while(|c: char| c.is_whitespace())),
                    terminated(app_id, char(' ')),
                    terminated(app_index, take_while(|c: char| c.is_whitespace())),
                    terminated(instance_id, take_while(|c: char| c.is_whitespace())),
                    terminated(x_cf_routererror, take_while(|c: char| c.is_whitespace())),
                    terminated(x_b3_traceid, take_while(|c: char| c.is_whitespace())),
                )),
                tuple((
                    terminated(x_b3_spanid, take_while(|c: char| c.is_whitespace())),
                    terminated(x_b3_parentspanid, take_while(|c: char| c.is_whitespace())),
                )),
            )),
            |(
                (
                    request_host,
                    _,
                    timestamp,
                    request,
                    status_code,
                    bytes_received,
                    bytes_sent,
                    referrer,
                    user_agent,
                    remote,
                    backend,
                    x_forwarded_for,
                    x_forwarded_proto,
                    vcap_request_id,
                    response_time,
                    gorouter_time,
                    app_id,
                    app_index,
                    instance_id,
                    x_cf_routererror,
                    trace_id,
                ),
                (span_id, parent_span_id),
            )| {
                GorouterLogEntry {
                    request_host,
                    timestamp,
                    request,
                    status_code,
                    bytes_received,
                    bytes_sent,
                    referrer,
                    user_agent,
                    remote_addr: remote.unwrap().0, // should always be there
                    remote_port: remote.unwrap().1, // should always be there
                    backend_addr: backend.map(|(addr, _)| addr),
                    backend_port: backend.map(|(_, port)| port),
                    x_forwarded_for,
                    x_forwarded_proto,
                    vcap_request_id,
                    response_time,
                    gorouter_time,
                    app_id,
                    app_index,
                    instance_id,
                    x_cf_routererror,
                    trace_id,
                    span_id,
                    parent_span_id,
                }
            },
        ),
    )(input)
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use chrono::{FixedOffset, NaiveDate, TimeZone};
    use http::Uri;
    use nom::error::VerboseError;

    use crate::{
        parsers::compound::{cloud_controller_log, combined_log, gorouter_log},
        RequestResult, XForwardedProto,
    };

    use super::common_log;

    #[test]
    fn parse_common_log_entry() {
        let data = r#"127.0.0.1 user-identifier frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326"#;
        let res = common_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.ip, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(
            e.identd_user.unwrap_or("<wrong identd user>"),
            "user-identifier"
        );
        assert_eq!(e.user.unwrap_or("<wrong user>"), "frank");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(7 * 3600)
                .unwrap()
                .with_ymd_and_hms(2000, 10, 10, 13, 55, 36)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/apache_pb.gif");
                assert_eq!(req.version(), http::Version::HTTP_10);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes, 2326);
    }

    #[test]
    fn parse_common_log_entry_ipv6() {
        let data = r#"2001:8a0:fa0d:ba01:5db0:ae0f:8444:161c - - [02/Mar/2019:17:39:56 +0000] "GET / HTTP/1.1" 200 66503"#;
        let res = common_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(
            e.ip,
            IpAddr::V6(Ipv6Addr::new(
                0x2001, 0x8a0, 0xfa0d, 0xba01, 0x5db0, 0xae0f, 0x8444, 0x161c
            ))
        );
        assert_eq!(e.identd_user, None);
        assert_eq!(e.user, None);
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .with_ymd_and_hms(2019, 3, 2, 17, 39, 56)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes, 66503);
    }

    #[test]
    fn parse_combined_log_entry() {
        let data = r#"127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)""#;
        let res = combined_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.ip, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(e.identd_user, None);
        assert_eq!(e.user.unwrap_or("<wrong user>"), "frank");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(7 * 3600)
                .unwrap()
                .with_ymd_and_hms(2000, 10, 10, 13, 55, 36)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/apache_pb.gif");
                assert_eq!(req.version(), http::Version::HTTP_10);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes, 2326);
        assert_eq!(
            e.referrer.unwrap(),
            "http://www.example.com/start.html".parse::<Uri>().unwrap()
        );
        assert_eq!(e.user_agent.unwrap(), "Mozilla/4.08 [en] (Win98; I ;Nav)");
    }

    #[test]
    fn parse_combined_log_entry_gh_issue_7() {
        let data = r#"127.0.0.1 - - [13/Jun/2022:05:26:31 +0100] "GET / HTTP/1.1" 301 166 "example.com" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36" 0.000 - 0e28d0563f4b737fce783ca10208cf8a - "-""#;
        let res = combined_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.ip, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(e.identd_user, None);
        assert_eq!(e.user, None);
        assert_eq!(
            e.timestamp,
            FixedOffset::east_opt(3600)
                .unwrap()
                .with_ymd_and_hms(2022, 6, 13, 5, 26, 31)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::MOVED_PERMANENTLY);
        assert_eq!(e.bytes, 166);
        assert_eq!(e.referrer.unwrap(), "example.com".parse::<Uri>().unwrap());
        assert_eq!(e.user_agent.unwrap(), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36");
    }

    #[test]
    fn parse_cloud_controller_log_entry() {
        let data = r#"api.system_domain.local - [01/Feb/2019:20:45:02 +0000] "GET /v2/spaces/a91c3fa8-e67d-40dd-9d6b-d01aefe5062a/summary HTTP/1.1" 200 53188 "-" "cf_exporter/" 172.26.28.115, 172.26.31.254, 172.26.30.2 vcap_request_id:49d47ebe-a54f-4f84-66a7-f1262800588b::67ee0d7f-08bd-401f-a46c-24d7501a5f92 response_time:0.252"#;
        let res = cloud_controller_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "api.system_domain.local");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .with_ymd_and_hms(2019, 2, 1, 20, 45, 2)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(
                    req.uri(),
                    "/v2/spaces/a91c3fa8-e67d-40dd-9d6b-d01aefe5062a/summary"
                );
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes, 53188);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent.unwrap(), "cf_exporter/");
        assert_eq!(e.x_forwarded_for.len(), 3);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(172, 26, 28, 115))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(172, 26, 31, 254))
        );
        assert_eq!(
            e.x_forwarded_for[2],
            IpAddr::V4(Ipv4Addr::new(172, 26, 30, 2))
        );
        assert_eq!(
            e.vcap_request_id.unwrap(),
            "49d47ebe-a54f-4f84-66a7-f1262800588b::67ee0d7f-08bd-401f-a46c-24d7501a5f92"
        );
        assert_eq!(e.response_time, Some(0.252));
    }

    #[test]
    fn parse_cloud_controller_log_with_no_response_time() {
        let data = r#"api.system_domain.local - [01/Feb/2019:15:26:42 +0000] "GET /v2/organizations?page=1&results-per-page=1&order-direction=asc HTTP/1.1" 499 0 "-" "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36" 10.1.43.82, 172.26.31.254, 172.26.28.40, 172.26.31.254, 172.26.30.1 vcap_request_id:- response_time:-"#;
        let res = cloud_controller_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "api.system_domain.local");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .with_ymd_and_hms(2019, 2, 1, 15, 26, 42)
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(
                    req.uri(),
                    "/v2/organizations?page=1&results-per-page=1&order-direction=asc"
                );
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::from_u16(499).unwrap());
        assert_eq!(e.bytes, 0);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent.unwrap(), "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
        assert_eq!(e.x_forwarded_for.len(), 5);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(10, 1, 43, 82))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(172, 26, 31, 254))
        );
        assert_eq!(
            e.x_forwarded_for[2],
            IpAddr::V4(Ipv4Addr::new(172, 26, 28, 40))
        );
        assert_eq!(
            e.x_forwarded_for[3],
            IpAddr::V4(Ipv4Addr::new(172, 26, 31, 254))
        );
        assert_eq!(
            e.x_forwarded_for[4],
            IpAddr::V4(Ipv4Addr::new(172, 26, 30, 1))
        );
        assert_eq!(e.vcap_request_id, None);
        assert_eq!(e.response_time, None);
    }

    #[test]
    fn parse_gorouter_access_log() {
        let data = r#"service.apps-domain.example.com - [2019-01-28T22:15:02.499+0000] "GET /v1/some/resource HTTP/1.1" 200 0 16409 "-" "Apache-HttpClient/4.3.3 (java 1.5)" "10.224.16.182:63326" "10.224.28.75:61022" x_forwarded_for:"10.178.177.71, 10.179.113.67, 10.224.16.182" x_forwarded_proto:"https" vcap_request_id:"e1604ad1-002c-48ff-6c44-f360e3096911" response_time:0.007799583 app_id:"2c3f3955-d0cd-444c-9350-3fc47bd44eaa" app_index:"0" x_b3_traceid:"f7a79a16ab5c8383" x_b3_spanid:"f7a79a16ab5c8383" x_b3_parentspanid:"-""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "service.apps-domain.example.com");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2019, 1, 28)
                        .unwrap()
                        .and_hms_milli_opt(22, 15, 2, 499)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/v1/some/resource");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 16409);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("Apache-HttpClient/4.3.3 (java 1.5)"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 224, 16, 182)));
        assert_eq!(e.remote_port, 63326);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 224, 28, 75)))
        );
        assert_eq!(e.backend_port, Some(61022));
        assert_eq!(e.x_forwarded_for.len(), 3);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(10, 178, 177, 71))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(10, 179, 113, 67))
        );
        assert_eq!(
            e.x_forwarded_for[2],
            IpAddr::V4(Ipv4Addr::new(10, 224, 16, 182))
        );
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTPS);
        assert_eq!(
            e.vcap_request_id,
            Some("e1604ad1-002c-48ff-6c44-f360e3096911")
        );
        assert_eq!(e.response_time, Some(0.007799583));
        assert_eq!(e.app_id, Some("2c3f3955-d0cd-444c-9350-3fc47bd44eaa"));
        assert_eq!(e.app_index, Some(0));
        assert_eq!(e.trace_id, Some("f7a79a16ab5c8383"));
        assert_eq!(e.span_id, Some("f7a79a16ab5c8383"));
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_without_zipkin_info() {
        let data = r#"service.apps-domain.example.com - [2019-01-28T22:15:02.499+0000] "GET /v1/some/resource HTTP/1.1" 200 0 16409 "-" "Apache-HttpClient/4.3.3 (java 1.5)" "10.224.16.182:63326" "10.224.28.75:61022" x_forwarded_for:"10.178.177.71, 10.179.113.67, 10.224.16.182" x_forwarded_proto:"https" vcap_request_id:"e1604ad1-002c-48ff-6c44-f360e3096911" response_time:0.007799583 app_id:"2c3f3955-d0cd-444c-9350-3fc47bd44eaa" app_index:"0""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "service.apps-domain.example.com");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2019, 1, 28)
                        .unwrap()
                        .and_hms_milli_opt(22, 15, 2, 499)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/v1/some/resource");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 16409);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("Apache-HttpClient/4.3.3 (java 1.5)"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 224, 16, 182)));
        assert_eq!(e.remote_port, 63326);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 224, 28, 75)))
        );
        assert_eq!(e.backend_port, Some(61022));
        assert_eq!(e.x_forwarded_for.len(), 3);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(10, 178, 177, 71))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(10, 179, 113, 67))
        );
        assert_eq!(
            e.x_forwarded_for[2],
            IpAddr::V4(Ipv4Addr::new(10, 224, 16, 182))
        );
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTPS);
        assert_eq!(
            e.vcap_request_id,
            Some("e1604ad1-002c-48ff-6c44-f360e3096911")
        );
        assert_eq!(e.response_time, Some(0.007799583));
        assert_eq!(e.app_id, Some("2c3f3955-d0cd-444c-9350-3fc47bd44eaa"));
        assert_eq!(e.app_index, Some(0));
        assert_eq!(e.trace_id, None);
        assert_eq!(e.span_id, None);
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_with_invalid_http_status() {
        let data = r#"doppler.example.com:4443 - [2019-01-28T18:35:38.720+0000] "GET /apps/5f13e1d2-1aa7-41d7-80d1-8df4cfd279c9/stream HTTP/1.1" "-" 0 0 "-" "CloudFoundryJavaClient/unknown (Java; Oracle Corporation/1.8.0_162) ReactorNetty/unknown (Netty/unknown)" "10.224.16.82:44768" "10.224.24.29:8081" x_forwarded_for:"10.224.16.82" x_forwarded_proto:"https" vcap_request_id:"a038e75b-581f-457d-7a49-c46b69d56aac" response_time:5.001585426 app_id:"-" app_index:"-" x_b3_traceid:"d8b747e82ff5c572" x_b3_spanid:"d8b747e82ff5c572" x_b3_parentspanid:"-""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "doppler.example.com:4443");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2019, 1, 28)
                        .unwrap()
                        .and_hms_milli_opt(18, 35, 38, 720)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(
                    req.uri(),
                    "/apps/5f13e1d2-1aa7-41d7-80d1-8df4cfd279c9/stream"
                );
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::IM_A_TEAPOT);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 0);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("CloudFoundryJavaClient/unknown (Java; Oracle Corporation/1.8.0_162) ReactorNetty/unknown (Netty/unknown)"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 224, 16, 82)));
        assert_eq!(e.remote_port, 44768);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 224, 24, 29)))
        );
        assert_eq!(e.backend_port, Some(8081));
        assert_eq!(e.x_forwarded_for.len(), 1);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(10, 224, 16, 82))
        );
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTPS);
        assert_eq!(
            e.vcap_request_id,
            Some("a038e75b-581f-457d-7a49-c46b69d56aac")
        );
        assert_eq!(e.response_time, Some(5.001585426));
        assert_eq!(e.app_id, None);
        assert_eq!(e.app_index, None);
        assert_eq!(e.trace_id, Some("d8b747e82ff5c572"));
        assert_eq!(e.span_id, Some("d8b747e82ff5c572"));
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_with_gorouter_time() {
        let data = r#"php-info.cfapps.io - [2020-07-23T19:46:59.042Z] "GET / HTTP/1.1" 200 0 399 "-" "curl/7.64.1" "10.10.66.179:28634" "10.10.148.45:61300" x_forwarded_for:"50.4.153.215, 10.10.66.179" x_forwarded_proto:"https" vcap_request_id:"c5794050-ac30-4911-5118-c5a8a4e8d09f" response_time:0.101468 gorouter_time:0.000104 app_id:"5f362051-e2bc-4abc-ab8e-adbdf688ae64" app_index:"0" x_b3_traceid:"e3e4a237210114ef" x_b3_spanid:"e3e4a237210114ef" x_b3_parentspanid:"-" b3:"e3e4a237210114ef-e3e4a237210114ef""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "php-info.cfapps.io");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2020, 7, 23)
                        .unwrap()
                        .and_hms_milli_opt(19, 46, 59, 42)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 399);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("curl/7.64.1"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 10, 66, 179)));
        assert_eq!(e.remote_port, 28634);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 10, 148, 45)))
        );
        assert_eq!(e.backend_port, Some(61300));
        assert_eq!(e.x_forwarded_for.len(), 2);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(50, 4, 153, 215))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(10, 10, 66, 179))
        );
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTPS);
        assert_eq!(
            e.vcap_request_id,
            Some("c5794050-ac30-4911-5118-c5a8a4e8d09f")
        );
        assert_eq!(e.response_time, Some(0.101468));
        assert_eq!(e.gorouter_time, Some(0.000104));
        assert_eq!(e.app_id, Some("5f362051-e2bc-4abc-ab8e-adbdf688ae64"));
        assert_eq!(e.app_index, Some(0));
        assert_eq!(e.trace_id, Some("e3e4a237210114ef"));
        assert_eq!(e.span_id, Some("e3e4a237210114ef"));
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_with_gorouter_time_and_x_cf_routererror() {
        let data = r#"php-info.cfapps.io - [2020-07-23T19:46:59.042Z] "GET / HTTP/1.1" 200 0 399 "-" "curl/7.64.1" "10.10.66.179:28634" "10.10.148.45:61300" x_forwarded_for:"50.4.153.215, 10.10.66.179" x_forwarded_proto:"https" vcap_request_id:"c5794050-ac30-4911-5118-c5a8a4e8d09f" response_time:0.101468 gorouter_time:0.000104 app_id:"5f362051-e2bc-4abc-ab8e-adbdf688ae64" app_index:"0" x_cf_routererror:"-" x_b3_traceid:"e3e4a237210114ef" x_b3_spanid:"e3e4a237210114ef" x_b3_parentspanid:"-" b3:"e3e4a237210114ef-e3e4a237210114ef""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "php-info.cfapps.io");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2020, 7, 23)
                        .unwrap()
                        .and_hms_milli_opt(19, 46, 59, 42)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::OK);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 399);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("curl/7.64.1"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 10, 66, 179)));
        assert_eq!(e.remote_port, 28634);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 10, 148, 45)))
        );
        assert_eq!(e.backend_port, Some(61300));
        assert_eq!(e.x_forwarded_for.len(), 2);
        assert_eq!(
            e.x_forwarded_for[0],
            IpAddr::V4(Ipv4Addr::new(50, 4, 153, 215))
        );
        assert_eq!(
            e.x_forwarded_for[1],
            IpAddr::V4(Ipv4Addr::new(10, 10, 66, 179))
        );
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTPS);
        assert_eq!(
            e.vcap_request_id,
            Some("c5794050-ac30-4911-5118-c5a8a4e8d09f")
        );
        assert_eq!(e.response_time, Some(0.101468));
        assert_eq!(e.gorouter_time, Some(0.000104));
        assert_eq!(e.x_cf_routererror, None);
        assert_eq!(e.app_id, Some("5f362051-e2bc-4abc-ab8e-adbdf688ae64"));
        assert_eq!(e.app_index, Some(0));
        assert_eq!(e.trace_id, Some("e3e4a237210114ef"));
        assert_eq!(e.span_id, Some("e3e4a237210114ef"));
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_with_x_forwarded_with_a_dash() {
        let data = r#"35.243.162.217:80 - [2019-10-31T00:11:09.329+0000] "GET / HTTP/1.1" 404 0 69 "-" "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36" "185.89.158.86:36539" "-" x_forwarded_for:"-" x_forwarded_proto:"-" vcap_request_id:"eb922abf-0f2d-4042-4a84-9161e6ee17a1" response_time:0.000108962 app_id:"-" app_index:"-" x_b3_traceid:"81aa595b268bbe68" x_b3_spanid:"81aa595b268bbe68" x_b3_parentspanid:"-" b3:"81aa595b268bbe68-81aa595b268bbe68""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "35.243.162.217:80");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2019, 10, 31)
                        .unwrap()
                        .and_hms_milli_opt(0, 11, 9, 329)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::GET);
                assert_eq!(req.uri(), "/");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::NOT_FOUND);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 69);
        assert_eq!(e.referrer, None);
        assert_eq!(e.user_agent, Some("Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(185, 89, 158, 86)));
        assert_eq!(e.remote_port, 36539);
        assert_eq!(e.backend_addr, None);
        assert_eq!(e.backend_port, None);
        assert_eq!(e.x_forwarded_for.len(), 0);
        assert_eq!(e.x_forwarded_proto, XForwardedProto::UNSPECIFIED);
        assert_eq!(
            e.vcap_request_id,
            Some("eb922abf-0f2d-4042-4a84-9161e6ee17a1")
        );
        assert_eq!(e.response_time, Some(0.000108962));
        assert_eq!(e.gorouter_time, None);
        assert_eq!(e.x_cf_routererror, None);
        assert_eq!(e.app_id, None);
        assert_eq!(e.app_index, None);
        assert_eq!(e.trace_id, Some("81aa595b268bbe68"));
        assert_eq!(e.span_id, Some("81aa595b268bbe68"));
        assert_eq!(e.parent_span_id, None);
    }

    #[test]
    fn parse_gorouter_access_log_with_instance_id() {
        let data = r#"labs-api.cfapps-06.slot-59.pez.vmware.com - [2022-02-02T16:46:41.401498446Z] "OPTIONS /status HTTP/1.1" 204 0 0 "http://support-lab-status.slot-59.pez.vmware.com/" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36" "10.213.60.5:35122" "10.213.60.26:61026" x_forwarded_for:"10.166.51.253, 10.213.60.5" x_forwarded_proto:"http" vcap_request_id:"af6f1df0-8f65-43c3-7087-0199c09d8a38" response_time:0.002673 gorouter_time:0.000645 app_id:"0c4f8c27-248c-4fe5-98f0-a4268a4b1393" app_index:"0" instance_id:"0c9cc45f-0eff-47e9-77b7-cbad" x_cf_routererror:"-" x_b3_traceid:"03a4f586178193ab" x_b3_spanid:"03a4f586178193ab" x_b3_parentspanid:"-" b3:"03a4f586178193ab-03a4f586178193ab""#;
        let res = gorouter_log::<VerboseError<&str>>(data);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let e = res.unwrap().1;
        assert_eq!(e.request_host, "labs-api.cfapps-06.slot-59.pez.vmware.com");
        assert_eq!(
            e.timestamp,
            FixedOffset::west_opt(0)
                .unwrap()
                .from_local_datetime(
                    &NaiveDate::from_ymd_opt(2022, 2, 2)
                        .unwrap()
                        .and_hms_nano_opt(16, 46, 41, 401498446)
                        .unwrap()
                )
                .unwrap()
        );
        match e.request {
            RequestResult::Valid(req) => {
                assert_eq!(req.method(), http::Method::OPTIONS);
                assert_eq!(req.uri(), "/status");
                assert_eq!(req.version(), http::Version::HTTP_11);
            }
            _ => panic!("invalid request: {:?}", e.request),
        }
        assert_eq!(e.status_code, http::StatusCode::NO_CONTENT);
        assert_eq!(e.bytes_received, 0);
        assert_eq!(e.bytes_sent, 0);
        assert_eq!(
            e.referrer,
            Some(
                "http://support-lab-status.slot-59.pez.vmware.com/"
                    .parse()
                    .unwrap()
            )
        );
        assert_eq!(e.user_agent, Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36"));
        assert_eq!(e.remote_addr, IpAddr::V4(Ipv4Addr::new(10, 213, 60, 5)));
        assert_eq!(e.remote_port, 35122);
        assert_eq!(
            e.backend_addr,
            Some(IpAddr::V4(Ipv4Addr::new(10, 213, 60, 26)))
        );
        assert_eq!(e.backend_port, Some(61026));
        assert_eq!(e.x_forwarded_for.len(), 2);
        assert_eq!(e.x_forwarded_proto, XForwardedProto::HTTP);
        assert_eq!(
            e.vcap_request_id,
            Some("af6f1df0-8f65-43c3-7087-0199c09d8a38")
        );
        assert_eq!(e.response_time, Some(0.002673));
        assert_eq!(e.gorouter_time, Some(0.000645));
        assert_eq!(e.app_id, Some("0c4f8c27-248c-4fe5-98f0-a4268a4b1393"));
        assert_eq!(e.app_index, Some(0));
        assert_eq!(e.instance_id, Some("0c9cc45f-0eff-47e9-77b7-cbad"));
        assert_eq!(e.x_cf_routererror, None);
        assert_eq!(e.trace_id, Some("03a4f586178193ab"));
        assert_eq!(e.span_id, Some("03a4f586178193ab"));
        assert_eq!(e.parent_span_id, None);
    }
}
