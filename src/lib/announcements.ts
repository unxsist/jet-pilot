/*
 * Announcements: a small feed on jet-pilot.app (announcements.json in the
 * jet-pilot-docs repo) that lets us reach installed versions without shipping
 * a release, e.g. to tell users of a version with a broken updater how to
 * update by hand. The feed is fetched through Rust (`fetch_announcements`,
 * src-tauri/src/announcements.rs); this module validates it and picks the
 * announcements meant for the running app.
 *
 * Feed format:
 *   {
 *     "announcements": [
 *       {
 *         "id": "2026-10-updater",          // unique, never reused
 *         "title": "…",
 *         "body": "Markdown …",
 *         "severity": "info" | "warning" | "critical",   // default info
 *         "platforms": ["macos", "windows", "linux"],    // default all
 *         "minVersion": "1.0.0",            // inclusive, optional
 *         "maxVersion": "1.38.1",           // inclusive, optional
 *         "expiresAt": "2026-12-31",        // optional
 *         "link": { "label": "Download", "url": "https://…" }  // optional
 *       }
 *     ]
 *   }
 *
 * Info and warning announcements are dismissed for good; critical ones come
 * back on every launch until the app is out of their version range.
 * Malformed entries are skipped, so a typo in one can't hide the others.
 */

export type AnnouncementSeverity = "info" | "warning" | "critical";
export type AnnouncementPlatform = "macos" | "windows" | "linux";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  platforms: AnnouncementPlatform[] | null;
  minVersion: string | null;
  maxVersion: string | null;
  expiresAt: string | null;
  link: { label: string; url: string } | null;
}

export interface AnnouncementTarget {
  version: string;
  platform: string;
  /** Ids the user dismissed. */
  dismissed: readonly string[];
  now?: Date;
}

const SEVERITIES: AnnouncementSeverity[] = ["info", "warning", "critical"];
const PLATFORMS: AnnouncementPlatform[] = ["macos", "windows", "linux"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** `major`, `major.minor` or `major.minor.patch`. */
const isVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  value.split(".").length <= 3 &&
  value.split(".").every((part) => /^\d+$/.test(part));

function parseAnnouncement(raw: unknown): Announcement | null {
  if (!isObject(raw)) return null;
  const { id, title, body } = raw;
  if (!nonEmptyString(id) || !nonEmptyString(title) || !nonEmptyString(body)) {
    return null;
  }

  let severity: AnnouncementSeverity = "info";
  if (raw.severity !== undefined) {
    if (!SEVERITIES.includes(raw.severity as AnnouncementSeverity)) return null;
    severity = raw.severity as AnnouncementSeverity;
  }

  let platforms: AnnouncementPlatform[] | null = null;
  if (raw.platforms !== undefined) {
    if (
      !Array.isArray(raw.platforms) ||
      !raw.platforms.every((p) => PLATFORMS.includes(p))
    ) {
      return null;
    }
    platforms = raw.platforms as AnnouncementPlatform[];
  }

  const version = (value: unknown): string | null | undefined => {
    if (value === undefined) return null;
    return isVersion(value) ? value : undefined;
  };
  const minVersion = version(raw.minVersion);
  const maxVersion = version(raw.maxVersion);
  if (minVersion === undefined || maxVersion === undefined) return null;

  let expiresAt: string | null = null;
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== "string" || isNaN(Date.parse(raw.expiresAt))) {
      return null;
    }
    expiresAt = raw.expiresAt;
  }

  let link: Announcement["link"] = null;
  if (raw.link !== undefined) {
    if (
      !isObject(raw.link) ||
      !nonEmptyString(raw.link.label) ||
      typeof raw.link.url !== "string" ||
      !raw.link.url.startsWith("https://")
    ) {
      return null;
    }
    link = { label: raw.link.label, url: raw.link.url };
  }

  return {
    id,
    title,
    body,
    severity,
    platforms,
    minVersion,
    maxVersion,
    expiresAt,
    link,
  };
}

/** Validates a fetched feed; malformed announcements are dropped. */
export function parseAnnouncements(feed: unknown): Announcement[] {
  if (!isObject(feed) || !Array.isArray(feed.announcements)) return [];
  const seen = new Set<string>();
  const announcements: Announcement[] = [];
  for (const raw of feed.announcements) {
    const announcement = parseAnnouncement(raw);
    if (announcement && !seen.has(announcement.id)) {
      seen.add(announcement.id);
      announcements.push(announcement);
    }
  }
  return announcements;
}

/**
 * Compares `major.minor.patch` versions (missing parts count as 0; a
 * pre-release or build suffix on the app version is ignored).
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Whether an announcement is meant for the running app and still pending. */
export function isAnnouncementFor(
  announcement: Announcement,
  target: AnnouncementTarget
): boolean {
  const { minVersion, maxVersion, platforms, expiresAt } = announcement;
  if (minVersion && compareVersions(target.version, minVersion) < 0) return false;
  if (maxVersion && compareVersions(target.version, maxVersion) > 0) return false;
  if (
    platforms &&
    !platforms.includes(target.platform as AnnouncementPlatform)
  ) {
    return false;
  }
  if (expiresAt && Date.parse(expiresAt) <= (target.now ?? new Date()).getTime()) {
    return false;
  }
  if (
    announcement.severity !== "critical" &&
    target.dismissed.includes(announcement.id)
  ) {
    return false;
  }
  return true;
}

/** The announcements to show, most severe first (feed order otherwise). */
export function pendingAnnouncements(
  feed: unknown,
  target: AnnouncementTarget
): Announcement[] {
  const rank = (a: Announcement) => SEVERITIES.length - SEVERITIES.indexOf(a.severity);
  return parseAnnouncements(feed)
    .filter((a) => isAnnouncementFor(a, target))
    .sort((a, b) => rank(a) - rank(b));
}
