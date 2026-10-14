import { describe, expect, it } from "vitest";
import {
  forwardLine,
  forwardTone,
  trafficLine,
} from "@/lib/portForwardView";
import { countForwards, forwardSummary } from "@/lib/portForwardSummary";

const base = {
  status: "ready" as const,
  error: null,
  reason: null,
  lastReconnect: null,
  namespace: "payments",
  context: "prod",
  engine: "native" as const,
};

describe("forward manager copy", () => {
  it("is quiet when healthy and says where", () => {
    expect(forwardLine(base)).toEqual({
      text: "payments · prod",
      tone: "muted",
    });
    expect(forwardLine({ ...base, engine: "kubectl" }).text).toBe(
      "payments · prod · via kubectl"
    );
  });

  it("mentions a recent heal in muted words, then lets it go", () => {
    const now = 10 * 60_000;
    const healed = {
      ...base,
      lastReconnect: { atMs: now - 4 * 60_000, reason: "pod was replaced" },
    };
    expect(forwardLine(healed, now)).toEqual({
      text: "Reconnected 4m ago · pod was replaced",
      tone: "muted",
    });
    expect(forwardLine(healed, now + 20 * 60_000).text).toBe("payments · prod");
  });

  it("puts problems in colour and words", () => {
    expect(
      forwardLine({ ...base, status: "reconnecting", reason: "Pod was replaced" })
    ).toEqual({ text: "Reconnecting · pod was replaced", tone: "warning" });
    expect(forwardLine({ ...base, status: "error", error: "Forbidden" })).toEqual({
      text: "Forbidden",
      tone: "destructive",
    });
    expect(
      forwardLine({ ...base, status: "starting", reason: "Waiting for a ready pod" })
        .text
    ).toBe("Starting · waiting for a ready pod");
    expect(forwardTone({ status: "reconnecting" })).toBe("warning");
    expect(forwardTone({ status: "starting" })).toBe("muted");
  });

  it("summarizes traffic", () => {
    expect(trafficLine(undefined)).toBeNull();
    expect(
      trafficLine({ openConnections: 0, connections: 0, bytesSent: 0, bytesReceived: 0 })
    ).toBeNull();
    expect(
      trafficLine({ openConnections: 2, connections: 9, bytesSent: 1000, bytesReceived: 1500 })
    ).toBe("2 open · 2.5 KB");
    expect(
      trafficLine({ openConnections: 0, connections: 1, bytesSent: 10, bytesReceived: 20 })
    ).toBe("1 connection · 30 B");
  });

  it("counts and summarizes forwards", () => {
    const counts = countForwards([
      { status: "ready" },
      { status: "starting" },
      { status: "reconnecting" },
      { status: "error" },
    ]);
    expect(counts).toEqual({ ready: 1, starting: 1, reconnecting: 1, failed: 1 });
    expect(forwardSummary(counts, 2)).toBe(
      "2 running · 1 reconnecting · 1 failed · 2 saved"
    );
    expect(forwardSummary(countForwards([]), 0)).toBe("Nothing forwarded");
  });
});
