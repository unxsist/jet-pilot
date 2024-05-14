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

use chrono::{DateTime, FixedOffset};
use http::uri::InvalidUri;
use nom::{
    branch::alt,
    bytes::complete::{is_a, tag, take_until, take_until1, take_while},
    character::complete::char,
    combinator::{map, map_res, opt, success},
    error::{context, ContextError, FromExternalError, ParseError},
    multi::separated_list0,
    number::complete::double,
    sequence::{delimited, preceded, separated_pair, terminated, tuple},
    AsChar, IResult,
};
use std::{
    net::{AddrParseError, IpAddr},
    num::ParseIntError,
};

use crate::{RequestResult, XForwardedProto};

pub(super) fn dash_or_str<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, Option<&'a str>, E> {
    context(
        "dash_or_str",
        alt((
            map(tag("-"), |_| None),
            opt(take_while(|c: char| !c.is_whitespace())),
        )),
    )(input)
}

pub(super) fn quoted_dash_or_str<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, Option<&'a str>, E> {
    context(
        "quoted_dash_or_str",
        delimited(
            char('"'),
            alt((map(tag("-"), |_| None), opt(take_until1("\"")))),
            char('"'),
        ),
    )(input)
}

pub(super) fn digits<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, &'a str, E> {
    context("digits", take_while(|c: char| c.is_ascii_digit()))(input)
}

pub(super) fn ip<'a, E>(input: &'a str) -> IResult<&'a str, IpAddr, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, AddrParseError>,
{
    context(
        "ip",
        map_res(
            take_while(|c: char| c.is_dec_digit() || c.is_hex_digit() || c == '.' || c == ':'),
            |out: &str| out.parse(),
        ),
    )(input)
}

pub(super) fn date<'a, E>(input: &'a str) -> IResult<&'a str, DateTime<FixedOffset>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, chrono::ParseError>,
{
    context(
        "date",
        map_res(delimited(char('['), take_until("]"), char(']')), |d| {
            DateTime::parse_from_str(d, "%d/%h/%Y:%H:%M:%S %z")
                .or_else(|_e| DateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S%z"))
                .or_else(|_e| DateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S%z"))
                .or_else(|_e| DateTime::parse_from_str(d, "%Y-%m-%dT%H:%M:%S%.f%z"))
                .or_else(|_e| DateTime::parse_from_rfc2822(d))
                .or_else(|_e| DateTime::parse_from_rfc3339(d))
        }),
    )(input)
}

pub(super) fn idnetd_user<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, Option<&'a str>, E> {
    context("idnetd_user", dash_or_str)(input)
}

pub(super) fn user<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, Option<&'a str>, E> {
    context("user", dash_or_str)(input)
}

pub(super) fn http_status<'a, E>(input: &'a str) -> IResult<&'a str, http::StatusCode, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, http::status::InvalidStatusCode>,
{
    context(
        "http_status",
        alt((
            map(tag("\"-\""), |_| http::StatusCode::IM_A_TEAPOT),
            map_res(take_until(" "), |h: &'a str| h.parse()),
        )),
    )(input)
}

pub(super) fn bytes<'a, E>(input: &'a str) -> IResult<&'a str, u64, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, std::num::ParseIntError>,
{
    context(
        "bytes",
        alt((
            map(tag("-"), |_| 0),
            map_res(digits, |b: &'a str| b.parse()),
        )),
    )(input)
}

pub(super) fn method<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, &'a str, E> {
    context("method", take_until(" "))(input)
}

pub(super) fn path<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, &'a str, E> {
    context("path", take_until(" "))(input)
}

pub(super) fn protocol_version<'a, E: ParseError<&'a str> + ContextError<&'a str>>(
    input: &'a str,
) -> IResult<&'a str, http::Version, E> {
    context(
        "protocol version",
        alt((
            map(tag("HTTP/1.0"), |_| http::Version::HTTP_10),
            map(tag("HTTP/1.1"), |_| http::Version::HTTP_11),
            map(tag("HTTP/2.0"), |_| http::Version::HTTP_11),
        )),
    )(input)
}

pub(super) fn request<'a, E>(input: &'a str) -> IResult<&'a str, RequestResult, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, http::Error>,
{
    context(
        "request",
        alt((
            delimited(
                char('"'),
                map(
                    tuple((
                        terminated(method, char(' ')),
                        terminated(path, char(' ')),
                        protocol_version,
                    )),
                    |(m, p, v)| {
                        let req = http::Request::builder()
                            .method(m)
                            .uri(p)
                            .version(v)
                            .body(());
                        match req {
                            Ok(r) => RequestResult::Valid(r),
                            Err(err) => RequestResult::InvalidPath(p, err),
                        }
                    },
                ),
                char('"'),
            ),
            map(quoted_dash_or_str, |p| match p {
                Some(p) => RequestResult::InvalidRequest(p),
                None => RequestResult::InvalidRequest(""),
            }),
        )),
    )(input)
}

pub(super) fn referrer<'a, E>(input: &'a str) -> IResult<&'a str, Option<http::Uri>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, InvalidUri>,
{
    context(
        "referrer",
        alt((
            map(tag("\"\""), |_| None),
            map(tag("\"-\""), |_| None),
            opt(delimited(
                char('"'),
                map_res(take_until1("\""), |s: &str| s.parse()),
                char('"'),
            )),
        )),
    )(input)
}

pub(super) fn user_agent<'a, E>(input: &'a str) -> IResult<&'a str, Option<&'a str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context("user_agent", quoted_dash_or_str)(input)
}

pub(super) fn ip_and_port<'a, E>(input: &'a str) -> IResult<&'a str, Option<(IpAddr, u16)>, E>
where
    E: ParseError<&'a str>
        + ContextError<&'a str>
        + FromExternalError<&'a str, AddrParseError>
        + FromExternalError<&'a str, ParseIntError>,
{
    context(
        "ip_and_port",
        delimited(
            char('"'),
            alt((
                map(tag("-"), |_| None),
                opt(separated_pair(
                    map_res(take_until1(":"), |ip: &str| ip.parse()),
                    char(':'),
                    map_res(digits, |p: &str| p.parse()),
                )),
            )),
            char('"'),
        ),
    )(input)
}

pub(super) fn ip_list<'a, E>(input: &'a str) -> IResult<&'a str, Vec<IpAddr>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, AddrParseError>,
{
    context("ip_list", separated_list0(is_a(", "), ip))(input)
}

pub(super) fn x_forwarded_for<'a, E>(input: &'a str) -> IResult<&'a str, Vec<IpAddr>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, AddrParseError>,
{
    context(
        "x_forwarded_for",
        alt((
            map(tag("x_forwarded_for:\"-\""), |_| vec![]),
            preceded(
                alt((tag("x_forwarded_for: "), tag("x_forwarded_for:"))),
                delimited(char('"'), ip_list, char('"')),
            ),
        )),
    )(input)
}

pub(super) fn x_forwarded_proto<'a, E>(input: &'a str) -> IResult<&'a str, XForwardedProto, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "x_forwarded_proto",
        map(
            preceded(
                tag("x_forwarded_proto:"),
                alt((quoted_dash_or_str, dash_or_str)),
            ),
            |t| match t {
                Some("http") => XForwardedProto::HTTP,
                Some("https") => XForwardedProto::HTTPS,
                _ => XForwardedProto::UNSPECIFIED,
            },
        ),
    )(input)
}

pub(super) fn vcap_request_id<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "vcap_request_id",
        alt((
            map(
                alt((tag("vcap_request_id:-"), tag("vcap_request_id:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("vcap_request_id: "), tag("vcap_request_id:"))),
                alt((quoted_dash_or_str, dash_or_str)),
            ),
        )),
    )(input)
}

pub(super) fn response_time<'a, E>(input: &'a str) -> IResult<&'a str, Option<f64>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "response_time",
        alt((
            map(
                alt((tag("response_time:-"), tag("response_time:\"-\""))),
                |_| None,
            ),
            opt(preceded(
                alt((tag("response_time: "), tag("response_time:"))),
                double,
            )),
        )),
    )(input)
}

pub(super) fn gorouter_time<'a, E>(input: &'a str) -> IResult<&'a str, Option<f64>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "gorouter_time",
        alt((
            map(
                alt((tag("gorouter_time:-"), tag("gorouter_time:\"-\""))),
                |_| None,
            ),
            opt(preceded(
                alt((tag("gorouter_time: "), tag("gorouter_time:"))),
                double,
            )),
        )),
    )(input)
}

pub(super) fn app_id<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "app_id",
        alt((
            map(alt((tag("app_id:-"), tag("app_id:\"-\""))), |_| None),
            preceded(alt((tag("app_id: "), tag("app_id:"))), quoted_dash_or_str),
        )),
    )(input)
}

pub(super) fn app_index<'a, E>(input: &'a str) -> IResult<&'a str, Option<u16>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str> + FromExternalError<&'a str, ParseIntError>,
{
    context(
        "app_index",
        alt((
            map(alt((tag("app_index:-"), tag("app_index:\"-\""))), |_| None),
            preceded(
                alt((tag("app_index: "), tag("app_index:"))),
                opt(map_res(
                    delimited(char('"'), digits, char('"')),
                    |p: &str| p.parse(),
                )),
            ),
        )),
    )(input)
}

pub(super) fn instance_id<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "instance_id",
        alt((
            map(
                alt((tag("instance_id:-"), tag("instance_id:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("instance_id: "), tag("instance_id:"))),
                quoted_dash_or_str,
            ),
            success(None),
        )),
    )(input)
}

pub(super) fn x_cf_routererror<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "x_cf_routererror",
        alt((
            map(
                alt((tag("x_cf_routererror:-"), tag("x_cf_routererror:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("x_cf_routererror: "), tag("x_cf_routererror:"))),
                quoted_dash_or_str,
            ),
            success(None),
        )),
    )(input)
}

pub(super) fn x_b3_traceid<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "x_b3_traceid",
        alt((
            map(
                alt((tag("x_b3_traceid:-"), tag("x_b3_traceid:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("x_b3_traceid: "), tag("x_b3_traceid:"))),
                quoted_dash_or_str,
            ),
            success(None),
        )),
    )(input)
}

pub(super) fn x_b3_spanid<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "x_b3_spanid",
        alt((
            map(
                alt((tag("x_b3_spanid:-"), tag("x_b3_spanid:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("x_b3_spanid: "), tag("x_b3_spanid:"))),
                quoted_dash_or_str,
            ),
            success(None),
        )),
    )(input)
}

pub(super) fn x_b3_parentspanid<'a, E>(input: &'a str) -> IResult<&'a str, Option<&str>, E>
where
    E: ParseError<&'a str> + ContextError<&'a str>,
{
    context(
        "x_b3_parentspanid",
        alt((
            map(
                alt((tag("x_b3_parentspanid:-"), tag("x_b3_parentspanid:\"-\""))),
                |_| None,
            ),
            preceded(
                alt((tag("x_b3_parentspanid: "), tag("x_b3_parentspanid:"))),
                quoted_dash_or_str,
            ),
            success(None),
        )),
    )(input)
}

#[cfg(test)]
mod core_tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate, TimeZone};
    use nom::error::{Error, ErrorKind, VerboseError};
    use nom::Err;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn parse_ip() {
        assert_eq!(
            ip::<VerboseError<&str>>("127.0.0.1 "),
            Ok((" ", IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))))
        )
    }

    #[test]
    fn parse_date() {
        let expected = FixedOffset::west_opt(7 * 3600)
            .unwrap()
            .with_ymd_and_hms(2000, 7, 25, 13, 55, 36)
            .unwrap();

        assert_eq!(
            date::<VerboseError<&str>>("[25/Jul/2000:13:55:36 -0700]"),
            Ok(("", expected))
        );

        assert_eq!(
            date::<VerboseError<&str>>("[2000-07-25 13:55:36-0700]"),
            Ok(("", expected))
        );
        assert_eq!(
            date::<VerboseError<&str>>("[2000-07-25T13:55:36-07:00]"),
            Ok(("", expected))
        );

        assert_eq!(
            date::<VerboseError<&str>>("[Tue, 25 Jul 2000 13:55:36 -0700]"),
            Ok(("", expected))
        );

        let expected = FixedOffset::west_opt(7 * 3600)
            .unwrap()
            .from_local_datetime(
                &NaiveDate::from_ymd_opt(2000, 7, 25)
                    .unwrap()
                    .and_hms_milli_opt(13, 55, 36, 499)
                    .unwrap(),
            )
            .unwrap();

        assert_eq!(
            date::<VerboseError<&str>>("[2000-07-25T13:55:36.499-0700]"),
            Ok(("", expected))
        );

        assert_eq!(
            date("[10/Oct/2000:13:55:36]"),
            Err(Err::Error(Error::new(
                "[10/Oct/2000:13:55:36]",
                ErrorKind::MapRes
            )))
        );
    }

    #[test]
    fn parse_dash_or_none() {
        assert_eq!(
            dash_or_str::<VerboseError<&str>>("foo "),
            Ok((" ", Some("foo")))
        );
        assert_eq!(dash_or_str::<VerboseError<&str>>("- "), Ok((" ", None)));
    }

    #[test]
    fn parse_quoted_dash_or_none() {
        assert_eq!(
            quoted_dash_or_str::<VerboseError<&str>>("\"foo\" "),
            Ok((" ", Some("foo")))
        );
        assert_eq!(
            quoted_dash_or_str::<VerboseError<&str>>("\"-\" "),
            Ok((" ", None))
        );
    }

    #[test]
    fn parse_http_status() {
        assert_eq!(
            http_status::<VerboseError<&str>>("404 "),
            Ok((" ", http::StatusCode::NOT_FOUND))
        );
        assert_eq!(
            http_status::<VerboseError<&str>>("418 "),
            Ok((" ", http::StatusCode::IM_A_TEAPOT))
        );
        assert_eq!(
            http_status::<VerboseError<&str>>("\"-\" "),
            Ok((" ", http::StatusCode::IM_A_TEAPOT))
        );
        assert_eq!(
            http_status(" "),
            Err(Err::Error(Error::new(" ", ErrorKind::MapRes)))
        );
    }

    #[test]
    fn parse_bytes() {
        assert_eq!(bytes::<VerboseError<&str>>("1234 "), Ok((" ", 1234)));
        assert_eq!(bytes::<VerboseError<&str>>("- "), Ok((" ", 0)));
        assert_eq!(
            bytes::<VerboseError<&str>>("8296735593 "),
            Ok((" ", 8296735593))
        );
    }

    #[test]
    fn parse_request() {
        let res = request::<VerboseError<&str>>(r#""GET /apache_pb.gif HTTP/1.0""#);
        assert!(res.is_ok(), "{}", res.unwrap_err());
        let resp = res.unwrap();

        if let RequestResult::Valid(req) = resp.1 {
            assert_eq!(req.method(), http::Method::GET);
            assert_eq!(req.uri(), "/apache_pb.gif");
            assert_eq!(req.version(), http::Version::HTTP_10);
        } else {
            panic!("unexpected response: {:?}", resp.1);
        }
    }

    #[test]
    fn parse_request_empty() {
        let internal = "\"";
        let data = format!("\"{}", internal);
        let res = request::<VerboseError<&str>>(&data);
        assert!(res.is_ok());
        assert!(matches!(res.unwrap().1, RequestResult::InvalidRequest(p) if p.is_empty()));
    }

    #[test]
    fn parse_request_invalid_junk_request1() {
        let inner = r#"H\x00\x00\x00tj\xA8\x9E#D\x98+\xCA\xF0\xA7\xBBl\xC5\x19\xD7\x8D\xB6\x18\xEDJ\x1En\xC1\xF9xu[l\xF0E\x1D-j\xEC\xD4xL\xC9r\xC9\x15\x10u\xE0%\x86Rtg\x05fv\x86]%\xCC\x80\x0C\xE8\xCF\xAE\x00\xB5\xC0f\xC8\x8DD\xC5\x09\xF4"#;
        let data = format!(r#""{}""#, inner);
        let res = request::<VerboseError<&str>>(&data);
        assert!(res.is_ok());
        let m = match res.unwrap().1 {
            RequestResult::InvalidRequest(p) => p,
            _ => "<wrong>",
        };
        assert_eq!(inner, m);
    }

    #[test]
    fn parse_request_invalid_junk_request2() {
        let inner = r#"238\x00ll|'|'|SGFjS2VkX0Q3NUU2QUFB|'|'|WIN-QZN7FJ7D1O|'|'|Administrator|'|'|18-11-28|'|'||'|'|Win 7 Ultimate SP1 x64|'|'|No|'|'|S17|'|'|..|'|'|SW5ib3ggLSBPdXRsb29rIERhdGEgRmlsZSAtIE1pY3Jvc29mdCBPdXRsb29rAA==|'|'|"#;
        let data = format!(r#""{}""#, inner);
        let res = request::<VerboseError<&str>>(&data);
        assert!(res.is_ok());
        let m = match res.unwrap().1 {
            RequestResult::InvalidRequest(p) => p,
            _ => "<wrong>",
        };
        assert_eq!(inner, m);
    }

    #[test]
    fn parse_request_invalid_from_gh_issue_2() {
        let inner = r#"GET /?a=fetch&content=<php>die(@md5(HelloThinkCMF))</php> HTTP/1.1"#;
        let data = format!(r#""{}""#, inner);
        let res = request::<VerboseError<&str>>(&data);
        assert!(res.is_ok());
        let (m, merr) = match res.unwrap().1 {
            RequestResult::InvalidPath(p, err) => (p, err),
            _ => panic!("should not happen"),
        };
        assert_eq!("/?a=fetch&content=<php>die(@md5(HelloThinkCMF))</php>", m);
        assert_eq!("invalid uri character", merr.to_string());
    }

    #[test]
    fn parse_referrer() {
        let data = "\"http://www.example.com/query\" ";
        let res = referrer::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        let (rem, r) = res.unwrap();
        assert_eq!(rem, " ");
        assert_eq!(r, Some("http://www.example.com/query".parse().unwrap()));
    }

    #[test]
    fn parse_referrer_that_is_unset() {
        let data = "\"-\" ";
        let res = referrer::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), (" ", None));
    }

    #[test]
    fn parse_referrer_that_is_empty() {
        let data = "\"\" ";
        let res = referrer::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), (" ", None));
    }

    #[test]
    fn parse_user_agent() {
        let data = "\"Mozilla/4.08 [en] (Win98; I ;Nav)\"";
        let res = user_agent::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("Mozilla/4.08 [en] (Win98; I ;Nav)"));
    }

    #[test]
    fn parse_user_agent_that_is_unset() {
        let data = "\"-\"";
        let res = user_agent::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_user_agent_that_is_empty() {
        let data = "\"\"";
        let res = user_agent::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_ip_and_port() {
        let data = "\"192.168.0.12:8080\"";
        let res = ip_and_port::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert!(res.as_ref().unwrap().1.is_some());
        assert_eq!(
            res.as_ref().unwrap().1.unwrap().0,
            Ipv4Addr::new(192, 168, 0, 12)
        );
        assert_eq!(res.unwrap().1.unwrap().1, 8080);
    }

    #[test]
    fn parse_ip_and_port_that_is_unset() {
        let data = "\"-\"";
        let res = ip_and_port::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert!(res.as_ref().unwrap().1.is_none());
    }

    #[test]
    fn parse_ip_and_port_that_is_empty() {
        let data = "\"\"";
        let res = ip_and_port::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert!(res.as_ref().unwrap().1.is_none());
    }

    #[test]
    fn parse_ip_list() {
        for data in [
            "10.10.10.1,10.10.10.2",
            "10.10.10.1, 10.10.10.2",
            "10.10.10.1 ,10.10.10.2",
            "10.10.10.1 , 10.10.10.2",
        ] {
            let res = ip_list::<VerboseError<&str>>(data);
            assert!(res.is_ok(), "{} - {}", data, res.err().unwrap());
            assert_eq!(
                res.unwrap().1,
                vec![Ipv4Addr::new(10, 10, 10, 1), Ipv4Addr::new(10, 10, 10, 2)],
                "{}",
                data
            );
        }
    }

    #[test]
    fn parse_ip_list_that_is_empty() {
        let data = "";
        let res = ip_list::<VerboseError<&str>>(data);
        assert!(res.is_ok());
        assert_eq!(res.as_ref().unwrap().1.len(), 0);
    }

    #[test]
    fn parse_x_forwarded_for() {
        for data in [
            "x_forwarded_for:\"10.10.10.1, 10.10.10.2\"",
            "x_forwarded_for: \"10.10.10.1, 10.10.10.2\"",
        ] {
            let res = x_forwarded_for::<VerboseError<&str>>(data);
            assert!(res.is_ok(), "{}", res.err().unwrap());
            assert_eq!(
                res.unwrap().1,
                vec![Ipv4Addr::new(10, 10, 10, 1), Ipv4Addr::new(10, 10, 10, 2)],
                "{}",
                data
            );
        }
    }

    #[test]
    fn parse_x_forwarded_proto() {
        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:\"http\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::HTTP);

        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:http ");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::HTTP);

        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:\"https\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::HTTPS);

        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:\"foo\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::UNSPECIFIED);

        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::UNSPECIFIED);

        let res = x_forwarded_proto::<VerboseError<&str>>("x_forwarded_proto:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, XForwardedProto::UNSPECIFIED);
    }

    #[test]
    fn parse_vcap_request_id() {
        let res = vcap_request_id::<VerboseError<&str>>(
            "vcap_request_id:\"e1604ad1-002c-48ff-6c44-f360e3096911\"",
        );
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = vcap_request_id::<VerboseError<&str>>(
            "vcap_request_id: \"e1604ad1-002c-48ff-6c44-f360e3096911\"",
        );
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = vcap_request_id::<VerboseError<&str>>("vcap_request_id:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = vcap_request_id::<VerboseError<&str>>("vcap_request_id:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_response_time() {
        let res = response_time::<VerboseError<&str>>("response_time:0.007799583");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0.007799583));

        let res = response_time::<VerboseError<&str>>("response_time: 0.007799583");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0.007799583));

        let res = response_time::<VerboseError<&str>>("response_time:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = response_time::<VerboseError<&str>>("response_time:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_gorouter_time() {
        let res = gorouter_time::<VerboseError<&str>>("gorouter_time:0.000104");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0.000104));

        let res = gorouter_time::<VerboseError<&str>>("gorouter_time: 0.000104");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0.000104));

        let res = gorouter_time::<VerboseError<&str>>("gorouter_time:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = gorouter_time::<VerboseError<&str>>("gorouter_time:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_app_id() {
        let res = app_id::<VerboseError<&str>>("app_id:\"e1604ad1-002c-48ff-6c44-f360e3096911\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = app_id::<VerboseError<&str>>("app_id: \"e1604ad1-002c-48ff-6c44-f360e3096911\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = app_id::<VerboseError<&str>>("app_id:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = app_id::<VerboseError<&str>>("app_id:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_app_index() {
        let res = app_index::<VerboseError<&str>>("app_index:\"0\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0));

        let res = app_index::<VerboseError<&str>>("app_index: \"0\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some(0));

        let res = app_index::<VerboseError<&str>>("app_index:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = app_index::<VerboseError<&str>>("app_index:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_instance_id() {
        let res = instance_id::<VerboseError<&str>>(
            "instance_id:\"e1604ad1-002c-48ff-6c44-f360e3096911\"",
        );
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = instance_id::<VerboseError<&str>>(
            "instance_id: \"e1604ad1-002c-48ff-6c44-f360e3096911\"",
        );
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("e1604ad1-002c-48ff-6c44-f360e3096911"));

        let res = instance_id::<VerboseError<&str>>("instance_id:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = instance_id::<VerboseError<&str>>("instance_id:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = instance_id::<VerboseError<&str>>("");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_x_cf_routererror() {
        let res = x_cf_routererror::<VerboseError<&str>>("x_cf_routererror:\"unknown_route\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("unknown_route"));

        let res = x_cf_routererror::<VerboseError<&str>>("x_cf_routererror: \"unknown_route\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("unknown_route"));

        let res = x_cf_routererror::<VerboseError<&str>>("x_cf_routererror:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_cf_routererror::<VerboseError<&str>>("x_cf_routererror:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_cf_routererror::<VerboseError<&str>>("");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_x_b3_traceid() {
        let res = x_b3_traceid::<VerboseError<&str>>("x_b3_traceid:\"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res = x_b3_traceid::<VerboseError<&str>>("x_b3_traceid: \"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res = x_b3_traceid::<VerboseError<&str>>("x_b3_traceid:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_traceid::<VerboseError<&str>>("x_b3_traceid:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_traceid::<VerboseError<&str>>("");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_x_b3_spanid() {
        let res = x_b3_spanid::<VerboseError<&str>>("x_b3_spanid:\"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res = x_b3_spanid::<VerboseError<&str>>("x_b3_spanid: \"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res = x_b3_spanid::<VerboseError<&str>>("x_b3_spanid:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_spanid::<VerboseError<&str>>("x_b3_spanid:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_spanid::<VerboseError<&str>>("");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }

    #[test]
    fn parse_x_b3_parentspanid() {
        let res = x_b3_parentspanid::<VerboseError<&str>>("x_b3_parentspanid:\"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res =
            x_b3_parentspanid::<VerboseError<&str>>("x_b3_parentspanid: \"f7a79a16ab5c8383\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, Some("f7a79a16ab5c8383"));

        let res = x_b3_parentspanid::<VerboseError<&str>>("x_b3_parentspanid:\"-\"");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_parentspanid::<VerboseError<&str>>("x_b3_parentspanid:-");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);

        let res = x_b3_parentspanid::<VerboseError<&str>>("");
        assert!(res.is_ok());
        assert_eq!(res.unwrap().1, None);
    }
}
