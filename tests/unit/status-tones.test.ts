import { describe, expect, test } from "vitest";
import { statusTone } from "../../src/components/ui/status/tones";

describe("statusTone", () => {
  test("maps healthy states to success", () => {
    expect(statusTone("Running")).toBe("success");
    expect(statusTone("deployed")).toBe("success");
    expect(statusTone("Bound")).toBe("success");
  });

  test("maps transitional states to warning", () => {
    expect(statusTone("Pending")).toBe("warning");
    expect(statusTone("ContainerCreating")).toBe("warning");
    expect(statusTone("Terminating")).toBe("warning");
    expect(statusTone("Init:0/2")).toBe("warning");
  });

  test("maps failures to destructive", () => {
    expect(statusTone("CrashLoopBackOff")).toBe("destructive");
    expect(statusTone("ImagePullBackOff")).toBe("destructive");
    expect(statusTone("OOMKilled")).toBe("destructive");
    expect(statusTone("Init:CrashLoopBackOff")).toBe("destructive");
    expect(statusTone("SomethingFailed")).toBe("destructive");
  });

  test("completed work is muted, unknown falls back", () => {
    expect(statusTone("Succeeded")).toBe("muted");
    expect(statusTone("Completed")).toBe("muted");
    expect(statusTone(undefined)).toBe("muted");
    expect(statusTone("Whatever", "info")).toBe("info");
  });
});
