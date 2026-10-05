//! EKS regions: an embedded list (the region picker, and the fallback for
//! discovery), and the regions enabled for an account through a hand-made
//! `ec2:DescribeRegions` call (SigV4, EC2 Query API) instead of the large
//! EC2 SDK crate.

use std::time::Duration;

use jp_auth_core::aws::aws_sigv4::http_request::{
    sign, SignableBody, SignableRequest, SigningSettings,
};
use jp_auth_core::aws::aws_sigv4::sign::v4;
use jp_auth_core::aws::aws_smithy_runtime_api::client::identity::Identity;
use jp_auth_core::aws::creds::AwsCredentials;
use jp_auth_core::aws::{AwsContext, AwsError};
use tauri_plugin_http::reqwest;

/// Regions with EKS (commercial, China, GovCloud), sorted.
pub const EKS_REGIONS: &[&str] = &[
    "af-south-1",
    "ap-east-1",
    "ap-east-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-6",
    "ap-southeast-7",
    "ca-central-1",
    "ca-west-1",
    "cn-north-1",
    "cn-northwest-1",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "mx-central-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-gov-east-1",
    "us-gov-west-1",
    "us-west-1",
    "us-west-2",
];

/// Commercial regions enabled for every account (no opt-in).
const DEFAULT_ENABLED: &[&str] = &[
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ca-central-1",
    "eu-central-1",
    "eu-north-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
];

const MAX_RESPONSE: usize = 256 * 1024;

/// The regions to scan when the enabled ones can't be listed: the
/// partition of `home_region`.
pub fn fallback_regions(home_region: &str) -> Vec<String> {
    let list: Vec<&str> = if home_region.starts_with("cn-") {
        vec!["cn-north-1", "cn-northwest-1"]
    } else if home_region.starts_with("us-gov-") {
        vec!["us-gov-east-1", "us-gov-west-1"]
    } else {
        DEFAULT_ENABLED.to_vec()
    };
    list.into_iter().map(str::to_string).collect()
}

fn ec2_host(region: &str) -> String {
    if region.starts_with("cn-") {
        format!("ec2.{region}.amazonaws.com.cn")
    } else {
        format!("ec2.{region}.amazonaws.com")
    }
}

/// The text of every `<tag>...</tag>` in `xml` (no nesting, no CDATA:
/// enough for EC2's flat answers).
fn tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(after[..end].trim().to_string());
        rest = &after[end + close.len()..];
    }
    out
}

/// Region names of a `DescribeRegions` answer.
pub fn parse_region_names(xml: &str) -> Vec<String> {
    let mut names: Vec<String> = tag_values(xml, "regionName")
        .into_iter()
        .filter(|n| jp_auth_core::request::valid_region(n))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// `ec2:DescribeRegions` (enabled regions only) in `region`.
pub async fn describe_regions(
    ctx: &AwsContext,
    credentials: &AwsCredentials,
    region: &str,
) -> Result<Vec<String>, AwsError> {
    let base = ctx
        .endpoints
        .ec2
        .clone()
        .unwrap_or_else(|| format!("https://{}", ec2_host(region)));
    let base = base.trim_end_matches('/');
    let host = base
        .split_once("://")
        .map(|(_, h)| h)
        .unwrap_or(base)
        .to_string();
    let url = format!("{base}/?Action=DescribeRegions&Version=2016-11-15");

    let identity: Identity = credentials.to_sdk().into();
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name("ec2")
        .time(std::time::SystemTime::now())
        .settings(SigningSettings::default())
        .build()
        .map_err(|e| AwsError::Invalid(e.to_string()))?
        .into();
    let request = SignableRequest::new(
        "GET",
        &url,
        [("host", host.as_str())].into_iter(),
        SignableBody::Bytes(&[]),
    )
    .map_err(|e| AwsError::Invalid(e.to_string()))?;
    let (instructions, _) = sign(request, &params)
        .map_err(|e| AwsError::Invalid(e.to_string()))?
        .into_parts();

    let client = reqwest::Client::builder()
        .user_agent("JET-Pilot")
        .timeout(ctx.timeout.max(Duration::from_secs(1)))
        .build()
        .map_err(|e| AwsError::Network(e.to_string()))?;
    let mut builder = client.get(&url);
    for (name, value) in instructions.headers() {
        builder = builder.header(name, value);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| AwsError::Network(format!("AWS could not be reached: {e}")))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|e| AwsError::Network(format!("AWS could not be reached: {e}")))?;
    let text = String::from_utf8_lossy(&body[..body.len().min(MAX_RESPONSE)]).into_owned();
    if !status.is_success() {
        return Err(AwsError::Service {
            code: tag_values(&text, "Code").into_iter().next(),
            message: tag_values(&text, "Message")
                .into_iter()
                .next()
                .unwrap_or_else(|| format!("DescribeRegions failed (HTTP {})", status.as_u16())),
        });
    }
    let names = parse_region_names(&text);
    if names.is_empty() {
        return Err(AwsError::Invalid(
            "DescribeRegions returned no regions".to_string(),
        ));
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jp_auth_core::aws::fake::{test_context, FakeResponse, FakeServer};

    const ANSWER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<DescribeRegionsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
    <regionInfo>
        <item>
            <regionName>us-east-1</regionName>
            <regionEndpoint>ec2.us-east-1.amazonaws.com</regionEndpoint>
            <optInStatus>opt-in-not-required</optInStatus>
        </item>
        <item>
            <regionName>eu-west-1</regionName>
            <regionEndpoint>ec2.eu-west-1.amazonaws.com</regionEndpoint>
            <optInStatus>opt-in-not-required</optInStatus>
        </item>
    </regionInfo>
</DescribeRegionsResponse>"#;

    #[test]
    fn lists_and_fallbacks() {
        assert_eq!(parse_region_names(ANSWER), vec!["eu-west-1", "us-east-1"]);
        assert!(EKS_REGIONS.windows(2).all(|w| w[0] < w[1]));
        assert!(fallback_regions("eu-west-1").contains(&"us-east-1".to_string()));
        assert_eq!(
            fallback_regions("cn-north-1"),
            vec!["cn-north-1", "cn-northwest-1"]
        );
        assert!(DEFAULT_ENABLED.iter().all(|r| EKS_REGIONS.contains(r)));
    }

    #[tokio::test]
    async fn describe_regions_is_signed_for_ec2() {
        let server = FakeServer::start(|req| {
            assert_eq!(req.query, "Action=DescribeRegions&Version=2016-11-15");
            let auth = req.header("authorization").unwrap_or_default();
            assert!(
                auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"),
                "{auth}"
            );
            assert!(auth.contains("/eu-west-1/ec2/aws4_request"));
            assert_eq!(req.header("x-amz-security-token"), Some("session"));
            FakeResponse::xml(200, ANSWER)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_context(dir.path(), &server.url);
        let credentials = AwsCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "secret".into(),
            session_token: Some("session".into()),
            expires_at: None,
        };
        let regions = describe_regions(&ctx, &credentials, "eu-west-1")
            .await
            .unwrap();
        assert_eq!(regions, vec!["eu-west-1", "us-east-1"]);

        let denied = FakeServer::start(|_| {
            FakeResponse::xml(
                403,
                "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized to perform this operation.</Message></Error></Errors></Response>",
            )
        })
        .await;
        let ctx = test_context(dir.path(), &denied.url);
        let err = describe_regions(&ctx, &credentials, "eu-west-1")
            .await
            .unwrap_err();
        assert_eq!(err.service_code(), Some("UnauthorizedOperation"));
    }
}
