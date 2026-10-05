//! EKS bearer tokens, as `aws eks get-token` makes them: a presigned
//! `sts:GetCallerIdentity` GET URL with the signed header
//! `x-k8s-aws-id: <cluster>` and `X-Amz-Expires=60`, base64url without
//! padding, prefixed `k8s-aws-v1.`. EKS accepts a token for 15 minutes;
//! like the CLI we report 14.

use std::borrow::Cow;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_sigv4::http_request::{
    sign, SignableBody, SignableRequest, SignatureLocation, SigningSettings,
};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;
use base64::Engine;

use super::creds::AwsCredentials;
use super::AwsError;

pub const PREFIX: &str = "k8s-aws-v1.";
pub const CLUSTER_HEADER: &str = "x-k8s-aws-id";
/// Lifetime reported in the ExecCredential.
pub const LIFETIME: Duration = Duration::from_secs(14 * 60);
const URL_EXPIRES: Duration = Duration::from_secs(60);

/// The regional STS host of `region` in its partition.
pub fn sts_host(region: &str) -> String {
    let suffix = if region.starts_with("cn-") {
        "amazonaws.com.cn"
    } else if region.starts_with("us-isob-") {
        "sc2s.sgov.gov"
    } else if region.starts_with("us-isof-") {
        "csp.hci.ic.gov"
    } else if region.starts_with("us-iso-") {
        "c2s.ic.gov"
    } else if region.starts_with("eu-isoe-") {
        "cloud.adc-e.uk"
    } else {
        "amazonaws.com"
    };
    format!("sts.{region}.{suffix}")
}

/// RFC 3986 unreserved characters stay, everything else is %XX (what
/// botocore does for presigned query strings).
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The presigned URL (query parameters in the aws CLI's order). `base`
/// overrides `https://<sts host>` (tests).
pub fn presigned_url(
    credentials: &AwsCredentials,
    region: &str,
    cluster: &str,
    time: SystemTime,
    base: Option<&str>,
) -> Result<String, AwsError> {
    let host = sts_host(region);
    let base = base
        .map(|b| b.trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("https://{host}"));
    let host_header = base
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest).to_string())
        .unwrap_or(host);
    let query = "Action=GetCallerIdentity&Version=2011-06-15";
    let url = format!("{base}/?{query}");

    let mut settings = SigningSettings::default();
    settings.signature_location = SignatureLocation::QueryParams;
    settings.expires_in = Some(URL_EXPIRES);
    let identity: Identity = credentials.to_sdk().into();
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name("sts")
        .time(time)
        .settings(settings)
        .build()
        .map_err(|e| AwsError::Invalid(format!("The EKS token can't be signed: {e}")))?
        .into();
    let headers = [("host", host_header.as_str()), (CLUSTER_HEADER, cluster)];
    let request = SignableRequest::new("GET", &url, headers.into_iter(), SignableBody::Bytes(&[]))
        .map_err(|e| AwsError::Invalid(format!("The EKS token can't be signed: {e}")))?;
    let (instructions, _signature) = sign(request, &params)
        .map_err(|e| AwsError::Invalid(format!("The EKS token can't be signed: {e}")))?
        .into_parts();
    let (_, params) = instructions.into_parts();

    // botocore's order: algorithm, credential, date, expires, signed
    // headers, security token, signature.
    let order = [
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Security-Token",
        "X-Amz-Signature",
    ];
    let mut out = url;
    for name in order {
        if let Some((_, value)) = params.iter().find(|(n, _)| *n == name) {
            let value: &Cow<'static, str> = value;
            out.push('&');
            out.push_str(name);
            out.push('=');
            out.push_str(&encode(value));
        }
    }
    Ok(out)
}

/// An EKS token for `cluster` and its expiry (unix seconds).
pub fn eks_token(
    credentials: &AwsCredentials,
    region: &str,
    cluster: &str,
    time: SystemTime,
    sts_base: Option<&str>,
) -> Result<(String, i64), AwsError> {
    let url = presigned_url(credentials, region, cluster, time, sts_base)?;
    let token = format!(
        "{PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes())
    );
    let expires_at = (time + LIFETIME)
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    Ok((token, expires_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generated with botocore (what `aws eks get-token` runs) for the same
    /// credentials, cluster and a clock fixed at 2026-10-05T12:00:00Z.
    const BOTOCORE_URL: &str = "https://sts.eu-west-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261005%2Feu-west-1%2Fsts%2Faws4_request&X-Amz-Date=20261005T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host%3Bx-k8s-aws-id&X-Amz-Security-Token=FwoGZXIvYXdzEXAMPLE%2F%2Ftoken%3D&X-Amz-Signature=b6e281966825f35c53300a37fdbc1ba3030f0626495b040d4e83c7efffd8c6b3";
    const BOTOCORE_TOKEN: &str = "k8s-aws-v1.aHR0cHM6Ly9zdHMuZXUtd2VzdC0xLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eSZWZXJzaW9uPTIwMTEtMDYtMTUmWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lERVhBTVBMRSUyRjIwMjYxMDA1JTJGZXUtd2VzdC0xJTJGc3RzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMDVUMTIwMDAwWiZYLUFtei1FeHBpcmVzPTYwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCUzQngtazhzLWF3cy1pZCZYLUFtei1TZWN1cml0eS1Ub2tlbj1Gd29HWlhJdllYZHpFWEFNUExFJTJGJTJGdG9rZW4lM0QmWC1BbXotU2lnbmF0dXJlPWI2ZTI4MTk2NjgyNWYzNWM1MzMwMGEzN2ZkYmMxYmEzMDMwZjA2MjY0OTViMDQwZDRlODNjN2VmZmZkOGM2YjM";

    fn credentials() -> AwsCredentials {
        AwsCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            session_token: Some("FwoGZXIvYXdzEXAMPLE//token=".into()),
            expires_at: None,
        }
    }

    #[test]
    fn matches_the_aws_cli_token() {
        let time = UNIX_EPOCH + Duration::from_secs(1_791_201_600);
        assert_eq!(
            presigned_url(&credentials(), "eu-west-1", "prod-cluster", time, None).unwrap(),
            BOTOCORE_URL
        );
        let (token, expires_at) =
            eks_token(&credentials(), "eu-west-1", "prod-cluster", time, None).unwrap();
        assert_eq!(token, BOTOCORE_TOKEN);
        assert_eq!(expires_at, 1_791_201_600 + 14 * 60);
    }

    #[test]
    fn partitions_get_their_sts_hosts() {
        assert_eq!(sts_host("eu-west-1"), "sts.eu-west-1.amazonaws.com");
        assert_eq!(sts_host("cn-north-1"), "sts.cn-north-1.amazonaws.com.cn");
        assert_eq!(sts_host("us-gov-west-1"), "sts.us-gov-west-1.amazonaws.com");
        assert_eq!(sts_host("us-iso-east-1"), "sts.us-iso-east-1.c2s.ic.gov");
        let time = UNIX_EPOCH + Duration::from_secs(1_791_201_600);
        let url = presigned_url(&credentials(), "cn-north-1", "c", time, None).unwrap();
        assert!(
            url.starts_with("https://sts.cn-north-1.amazonaws.com.cn/?Action=GetCallerIdentity")
        );
        assert!(url.contains("%2Fcn-north-1%2Fsts%2Faws4_request"));
        // Long-term keys: no security token.
        let mut keys = credentials();
        keys.session_token = None;
        let url = presigned_url(&keys, "eu-west-1", "c", time, None).unwrap();
        assert!(!url.contains("X-Amz-Security-Token"));
        assert!(url.ends_with(&format!(
            "&X-Amz-Signature={}",
            url.rsplit('=').next().unwrap()
        )));
    }
}
