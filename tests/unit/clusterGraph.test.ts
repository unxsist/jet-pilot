import { describe, expect, test } from "vitest";
import {
  buildOwnerIndex,
  dedupeResources,
  mapWithConcurrency,
  qualifiedResourceName,
} from "@/lib/clusterGraph";

describe("qualifiedResourceName", () => {
  test("qualifies non-core resources with their group", () => {
    expect(
      qualifiedResourceName({
        name: "gateways",
        group: "networking.istio.io",
        kind: "Gateway",
      })
    ).toBe("gateways.networking.istio.io");
    expect(
      qualifiedResourceName({ name: "pods", group: "", kind: "Pod" })
    ).toBe("pods");
  });
});

describe("dedupeResources", () => {
  test("keeps equally named kinds of different groups", () => {
    const resources = [
      { name: "gateways", group: "networking.istio.io", kind: "Gateway" },
      {
        name: "gateways",
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
      },
      { name: "gateways", group: "networking.istio.io", kind: "Gateway" },
    ];
    expect(dedupeResources(resources)).toEqual(resources.slice(0, 2));
  });
});

describe("buildOwnerIndex", () => {
  test("indexes children under every owner uid", () => {
    const rs = { metadata: { uid: "rs", ownerReferences: [{ uid: "dep" }] } };
    const pod1 = { metadata: { uid: "p1", ownerReferences: [{ uid: "rs" }] } };
    const pod2 = {
      metadata: { uid: "p2", ownerReferences: [{ uid: "rs" }, { uid: "x" }] },
    };
    const orphan = { metadata: { uid: "o" } };

    const index = buildOwnerIndex([rs, pod1, pod2, orphan]);

    expect(index.get("dep")).toEqual([rs]);
    expect(index.get("rs")).toEqual([pod1, pod2]);
    expect(index.get("x")).toEqual([pod2]);
    expect(index.has("o")).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  test("never exceeds the limit and keeps result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(
      [5, 1, 4, 2, 3, 0, 6],
      3,
      async (delay) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delay));
        inFlight--;
        if (delay === 2) throw new Error("boom");
        return delay * 10;
      }
    );

    expect(maxInFlight).toBe(3);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(50);
  });

  test("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
  });
});
