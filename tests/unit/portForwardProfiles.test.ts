import { describe, expect, it } from "vitest";
import {
  createProfile,
  isProfileRunning,
  parseProfiles,
  profileId,
  profilesToAutoStart,
  upsertProfile,
  type PortForwardSpec,
} from "@/lib/portForwardProfiles";

const spec: PortForwardSpec = {
  kubeConfig: "/k",
  context: "prod",
  namespace: "payments",
  objectType: "service",
  objectName: "payments-api",
  objectPort: 80,
  localPort: 8080,
  address: "127.0.0.1",
};

describe("port-forward profiles", () => {
  it("derives a stable id and a default name from the spec", () => {
    const profile = createProfile({ ...spec, id: "pf-1", status: "ready" } as any);
    expect(profile.id).toBe(profileId(spec));
    expect(profile.name).toBe("payments-api:80 → 8080");
    expect(profile.spec).toEqual(spec);
    expect(profile.autoStart).toBe(false);
  });

  it("matches running forwards and only auto-starts the missing ones", () => {
    const running = createProfile(spec, { autoStart: true });
    const missing = createProfile({ ...spec, localPort: 9090 }, { autoStart: true });
    const manual = createProfile({ ...spec, localPort: 7070 });
    const forwards = [{ ...spec, id: "pf-1", status: "ready" } as any];

    expect(isProfileRunning(running, forwards)).toBe(true);
    expect(profilesToAutoStart([running, missing, manual], forwards)).toEqual([missing]);
  });

  it("upserts by id, keeping the order", () => {
    const a = createProfile(spec);
    const b = createProfile({ ...spec, localPort: 9090 });
    const renamed = createProfile(spec, { name: "API" });
    expect(upsertProfile([a, b], renamed).map((p) => p.name)).toEqual([
      "API",
      b.name,
    ]);
    expect(upsertProfile([a], b)).toHaveLength(2);
  });

  it("validates stored profiles", () => {
    const parsed = parseProfiles([
      { name: "ok", spec, autoStart: true },
      { name: "dup", spec },
      { name: "bad port", spec: { ...spec, localPort: 70000 } },
      { name: "bad type", spec: { ...spec, objectType: "job" } },
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "ok", autoStart: true });
    expect(parseProfiles("nope")).toEqual([]);
  });
});
