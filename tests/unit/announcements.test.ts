import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseAnnouncements,
  pendingAnnouncements,
} from "@/lib/announcements";

const base = { id: "a", title: "Title", body: "Body" };
const target = { version: "1.38.1", platform: "macos", dismissed: [] };
const feed = (...announcements: unknown[]) => ({ announcements });
const ids = (f: unknown, t = target) =>
  pendingAnnouncements(f, t).map((a) => a.id);

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("1.38.1", "1.38.1")).toBe(0);
    expect(compareVersions("1.9.0", "1.38.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.38", "1.38.0")).toBe(0);
    expect(compareVersions("1.39.0-beta.1", "1.39.0")).toBe(0);
  });
});

describe("parseAnnouncements", () => {
  it("applies defaults", () => {
    expect(parseAnnouncements(feed(base))).toEqual([
      {
        ...base,
        severity: "info",
        platforms: null,
        minVersion: null,
        maxVersion: null,
        expiresAt: null,
        link: null,
      },
    ]);
  });

  it("skips malformed entries but keeps the rest", () => {
    const parsed = parseAnnouncements(
      feed(
        { ...base, id: "" },
        { ...base, id: "b", severity: "urgent" },
        { ...base, id: "c", platforms: ["macos", "beos"] },
        { ...base, id: "d", maxVersion: "latest" },
        { ...base, id: "e", link: { label: "Go", url: "javascript:alert(1)" } },
        { ...base, id: "f", expiresAt: "someday" },
        "nope",
        { ...base, id: "ok" },
        { ...base, id: "ok", title: "duplicate" }
      )
    );
    expect(parsed.map((a) => a.id)).toEqual(["ok"]);
    expect(parsed[0].title).toBe("Title");
  });

  it("returns nothing for a broken feed", () => {
    expect(parseAnnouncements(null)).toEqual([]);
    expect(parseAnnouncements({ announcements: "x" })).toEqual([]);
    expect(parseAnnouncements([base])).toEqual([]);
  });
});

describe("pendingAnnouncements", () => {
  it("matches the version range inclusively", () => {
    const f = feed(
      { ...base, id: "upTo", maxVersion: "1.38.1" },
      { ...base, id: "before", maxVersion: "1.38.0" },
      { ...base, id: "from", minVersion: "1.38.1" },
      { ...base, id: "after", minVersion: "1.39.0" }
    );
    expect(ids(f)).toEqual(["upTo", "from"]);
  });

  it("filters on platform", () => {
    const f = feed(
      { ...base, id: "mac", platforms: ["macos"] },
      { ...base, id: "win", platforms: ["windows", "linux"] }
    );
    expect(ids(f)).toEqual(["mac"]);
    expect(ids(f, { ...target, platform: "linux" })).toEqual(["win"]);
  });

  it("drops expired announcements", () => {
    const f = feed({ ...base, expiresAt: "2026-10-01" });
    expect(ids(f, { ...target, now: new Date("2026-09-30T12:00:00Z") })).toEqual(["a"]);
    expect(ids(f, { ...target, now: new Date("2026-10-02T00:00:00Z") })).toEqual([]);
  });

  it("hides dismissed announcements, except critical ones", () => {
    const f = feed(
      { ...base, id: "info" },
      { ...base, id: "critical", severity: "critical" }
    );
    expect(ids(f, { ...target, dismissed: ["info", "critical"] })).toEqual([
      "critical",
    ]);
  });

  it("orders by severity, then feed order", () => {
    const f = feed(
      { ...base, id: "info1" },
      { ...base, id: "warning", severity: "warning" },
      { ...base, id: "info2" },
      { ...base, id: "critical", severity: "critical" }
    );
    expect(ids(f)).toEqual(["critical", "warning", "info1", "info2"]);
  });
});
