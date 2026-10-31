import { describe, expect, test } from "vitest";
import {
  checkRollout,
  followName,
  isRolloutKind,
  manifestWorkloads,
  rolloutMessage,
  type RolloutRef,
} from "../../src/lib/rolloutFollow";
import type { Workload } from "../../src/lib/rollout";

const T0 = 1_800_000_000_000;

const deployment = (status: Workload["status"], spec: Workload["spec"] = {}, generation = 2): Workload => ({
  kind: "Deployment",
  metadata: { name: "checkout-api", generation },
  spec: { replicas: 3, ...spec },
  status: { observedGeneration: generation, replicas: 3, ...status },
});

const ref = (name: string, kind: RolloutRef["kind"] = "Deployment"): RolloutRef => ({
  context: "prod",
  namespace: "shop",
  kind,
  name,
});

describe("checking a rollout", () => {
  test("waits for the controller, then for the new replicas", () => {
    const unobserved = checkRollout({ ...deployment({ updatedReplicas: 3, availableReplicas: 3 }), metadata: { generation: 3 } }, null, T0);
    expect(unobserved.state).toBe("progressing");
    const halfway = checkRollout(deployment({ updatedReplicas: 1, readyReplicas: 3, availableReplicas: 3 }), null, T0);
    expect(halfway.state).toBe("progressing");
  });

  test("complete, in the panel's words", () => {
    const done = checkRollout(deployment({ updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 }), null, T0);
    expect(done).toEqual({ state: "complete", detail: "All 3 replicas are on the new version and ready." });
    const one = checkRollout(
      deployment({ replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }, { replicas: 1 }),
      null,
      T0
    );
    expect(one).toEqual({ state: "complete", detail: "Its replica is on the new version and ready." });
    const zero = checkRollout(deployment({ replicas: 0 }, { replicas: 0 }), null, T0);
    expect(zero).toEqual({ state: "complete", detail: "Scaled to zero." });
  });

  test("a Deployment past its progress deadline is stuck", () => {
    const stuck = checkRollout(
      deployment({
        updatedReplicas: 1,
        conditions: [
          {
            type: "Progressing",
            status: "False",
            reason: "ProgressDeadlineExceeded",
            message: 'ReplicaSet "checkout-api-7d9f8b6c4" has timed out progressing.',
          },
        ],
      }),
      null,
      T0
    );
    expect(stuck).toEqual({ state: "stuck", detail: "The new pods didn't become ready in time." });
  });

  test("a paused Deployment won't finish", () => {
    expect(checkRollout(deployment({ updatedReplicas: 1 }, { paused: true }), null, T0).state).toBe("paused");
  });

  test("a StatefulSet without progress for ten minutes is stuck", () => {
    const sts: Workload = {
      kind: "StatefulSet",
      metadata: { generation: 4 },
      spec: { replicas: 3 },
      status: { observedGeneration: 4, replicas: 3, updatedReplicas: 1, readyReplicas: 2, currentRevision: "a", updateRevision: "b" },
    };
    const first = checkRollout(sts, null, T0);
    expect(first.state).toBe("progressing");
    const mark = first.state === "progressing" ? first.mark : null;
    const later = checkRollout(sts, mark, T0 + 9 * 60_000);
    expect(later.state).toBe("progressing");
    // Progress resets the clock.
    const moved = checkRollout({ ...sts, status: { ...sts.status, updatedReplicas: 2 } }, mark, T0 + 9 * 60_000);
    expect(moved.state === "progressing" && moved.mark.since).toBe(T0 + 9 * 60_000);
    const stuck = checkRollout(sts, mark, T0 + 10 * 60_000);
    expect(stuck).toEqual({
      state: "stuck",
      detail: "No progress for 10m: 1 of 3 replicas are on the new version, 2 ready.",
    });
  });

  test("DaemonSets speak of nodes", () => {
    const ds: Workload = {
      kind: "DaemonSet",
      metadata: { generation: 1 },
      status: { observedGeneration: 1, desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 5, numberAvailable: 5 },
    };
    expect(checkRollout(ds, null, T0)).toEqual({ state: "complete", detail: "All 5 nodes run the new version." });
  });
});

describe("the message", () => {
  const complete = { state: "complete" as const, detail: "All 3 replicas are on the new version and ready." };

  test("rolled out, once everything is", () => {
    expect(rolloutMessage("checkout-api", [{ ref: ref("checkout-api"), check: complete }])).toEqual({
      outcome: "complete",
      title: "checkout-api rolled out",
      body: "All 3 replicas are on the new version and ready.",
      ref: ref("checkout-api"),
    });
    expect(
      rolloutMessage("shop", [
        { ref: ref("web"), check: complete },
        { ref: ref("worker"), check: complete },
      ])?.body
    ).toBe("Both workloads are on the new version.");
  });

  test("nothing yet while one is still rolling out", () => {
    const progressing = { state: "progressing" as const, mark: { key: "", since: T0 } };
    expect(
      rolloutMessage("shop", [
        { ref: ref("web"), check: complete },
        { ref: ref("worker"), check: progressing },
      ])
    ).toBeNull();
    expect(rolloutMessage("shop", [])).toBeNull();
  });

  test("a stuck workload is the news, by its own name", () => {
    const message = rolloutMessage("shop", [
      { ref: ref("web"), check: complete },
      { ref: ref("worker"), check: { state: "stuck", detail: "The new pods didn't become ready in time." } },
    ]);
    expect(message).toMatchObject({
      outcome: "stuck",
      title: "worker's rollout is stuck",
      body: "The new pods didn't become ready in time.",
      ref: ref("worker"),
    });
    expect(
      rolloutMessage("api", [{ ref: ref("api"), check: { state: "paused", detail: "Rollouts are paused until it is resumed." } }])
        ?.title
    ).toBe("api's rollout is paused");
  });

  test("names for several workloads", () => {
    expect(followName([ref("web")])).toBe("web");
    expect(followName([ref("web"), ref("api")])).toBe("2 deployments");
    expect(followName([ref("web"), ref("db", "StatefulSet")])).toBe("2 workloads");
    expect(isRolloutKind("Deployment")).toBe(true);
    expect(isRolloutKind("ReplicaSet")).toBe(false);
  });
});

describe("a Helm release's workloads", () => {
  test("from its manifest, in the release namespace unless set", () => {
    const manifest = [
      "---",
      "# Source: shop/templates/service.yaml",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: web",
      "---",
      "# Source: shop/templates/deployment.yaml",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: web",
      "  labels:",
      "    name: not-this-one",
      "spec:",
      "  template:",
      "    metadata:",
      "      name: nor-this",
      "---",
      "apiVersion: apps/v1",
      "kind: StatefulSet",
      "metadata:",
      '  name: "db"',
      "  namespace: data",
      "---",
      "kind: ConfigMap",
      "metadata:",
      "  name: settings",
    ].join("\n");
    expect(manifestWorkloads(manifest, { context: "prod", namespace: "shop" })).toEqual([
      { context: "prod", namespace: "shop", kind: "Deployment", name: "web" },
      { context: "prod", namespace: "data", kind: "StatefulSet", name: "db" },
    ]);
  });
});
