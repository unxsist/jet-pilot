import { describe, expect, it } from "vitest";
import { countHeaders, noCountedPeriods, periodsOf } from "@/lib/usage";

const app = { version: "2.1.0", os: "linux", arch: "x86_64" };

describe("periodsOf", () => {
  it("uses the UTC day, ISO week and month", () => {
    expect(periodsOf(new Date("2026-10-08T12:00:00Z"))).toEqual({
      day: "2026-10-08",
      week: "2026-W41",
      month: "2026-10",
    });
  });

  it("puts the first days of a year in the previous year's last week when ISO says so", () => {
    expect(periodsOf(new Date("2027-01-01T00:00:00Z")).week).toBe("2026-W53");
    expect(periodsOf(new Date("2026-01-01T00:00:00Z")).week).toBe("2026-W01");
    expect(periodsOf(new Date("2024-12-30T00:00:00Z")).week).toBe("2025-W01");
  });

  it("starts weeks on Monday", () => {
    expect(periodsOf(new Date("2026-10-11T23:59:59Z")).week).toBe("2026-W41");
    expect(periodsOf(new Date("2026-10-12T00:00:00Z")).week).toBe("2026-W42");
  });
});

describe("countHeaders", () => {
  it("counts a first check in every period", () => {
    const { headers, counted } = countHeaders(new Date("2026-10-08T09:00:00Z"), noCountedPeriods(), app);
    expect(headers).toEqual({
      "X-JetPilot-Count": "day,week,month",
      "X-JetPilot-Version": "2.1.0",
      "X-JetPilot-OS": "linux",
      "X-JetPilot-Arch": "x86_64",
    });
    expect(counted).toEqual({ day: "2026-10-08", week: "2026-W41", month: "2026-10" });
  });

  it("counts only the periods not counted yet", () => {
    const counted = { day: "2026-10-07", week: "2026-W41", month: "2026-10" };
    expect(countHeaders(new Date("2026-10-08T09:00:00Z"), counted, app).headers["X-JetPilot-Count"]).toBe("day");
  });

  it("sends none on a later check the same day", () => {
    const counted = { day: "2026-10-08", week: "2026-W41", month: "2026-10" };
    expect(countHeaders(new Date("2026-10-08T18:00:00Z"), counted, app).headers["X-JetPilot-Count"]).toBe("none");
  });
});
