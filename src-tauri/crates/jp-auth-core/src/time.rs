//! RFC 3339 timestamps in UTC without a date library: the AWS token caches
//! and `ExecCredential.status.expirationTimestamp` need nothing more.

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i64;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number (inverse of [`days_from_civil`]).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `2026-10-05T12:00:00Z` for seconds since the epoch (the format the aws
/// CLI writes into `~/.aws/sso/cache`).
pub fn format_rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

fn number(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Seconds since the epoch of an RFC 3339 timestamp: `Z`, `+hh:mm` /
/// `-hh:mm` offsets, the `UTC` suffix older aws CLIs wrote, a space instead
/// of `T`, and fractional seconds (dropped).
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.len() < 19 || !text.is_char_boundary(19) {
        return None;
    }
    let (date_time, zone) = text.split_at(19);
    let bytes = date_time.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year = number(&date_time[0..4])?;
    let month = number(&date_time[5..7])? as u32;
    let day = number(&date_time[8..10])? as u32;
    let hour = number(&date_time[11..13])?;
    let minute = number(&date_time[14..16])?;
    let second = number(&date_time[17..19])?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut zone = zone;
    if let Some(fraction) = zone.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        zone = &fraction[digits..];
    }
    let offset = match zone {
        "Z" | "z" | "UTC" | "+00:00" | "-00:00" => 0,
        _ => {
            let sign = match zone.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (hours, minutes) = zone[1..].split_once(':')?;
            sign * (number(hours)? * 3600 + number(minutes)? * 60)
        }
    };
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_utc() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(1_791_201_600), "2026-10-05T12:00:00Z");
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        for secs in [0, 59, 86_399, 951_782_400, 1_791_201_600, 4_102_444_800] {
            assert_eq!(parse_rfc3339(&format_rfc3339(secs)), Some(secs));
        }
        assert_eq!(parse_rfc3339("2026-10-05T12:00:00UTC"), Some(1_791_201_600));
        assert_eq!(
            parse_rfc3339("2026-10-05T14:00:00+02:00"),
            Some(1_791_201_600)
        );
        assert_eq!(
            parse_rfc3339("2026-10-05T12:00:00.123456Z"),
            Some(1_791_201_600)
        );
        assert_eq!(parse_rfc3339("2026-10-05 12:00:00Z"), Some(1_791_201_600));
        for bad in [
            "",
            "2026-10-05",
            "2026-13-05T12:00:00Z",
            "2026-10-05T12:00:00",
            "x026-10-05T12:00:00Z",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }
}
