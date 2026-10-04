import { describe, expect, test } from "vitest";
import type { CoreV1Event, V1Node, V1Pod } from "@kubernetes/client-node";
import {
  describeRows,
  getResourceTabId,
  getResourceTabTitle,
  getRowIdentity,
  resolveCreateTarget,
} from "@/components/tables/identity";
import {
  getDeploymentReadiness,
  getEventLastSeen,
  getEventTypeTone,
  getNodeStatus,
  getNodeStatusTone,
  getPodReadiness,
  getPodReadinessTone,
  getPodRestarts,
  getPodStatus,
  getPodStatusTone,
  getReplicaTone,
  getRestartsTone,
} from "@/components/tables/status";
import { formatAge, toDate } from "@/components/tables/age";
import { describeFailures } from "@/composables/useResourceList";

describe("row identity", () => {
  test("uses context + uid", () => {
    expect(
      getRowIdentity({ metadata: { context: "prod", uid: "abc", name: "x" } })
    ).toBe("prod/abc");
  });

  test("same uid in different contexts gives different ids", () => {
    const a = getRowIdentity({ metadata: { context: "a", uid: "1" } });
    const b = getRowIdentity({ metadata: { context: "b", uid: "1" } });
    expect(a).not.toBe(b);
  });

  test("falls back to namespace/name for helm rows", () => {
    expect(
      getRowIdentity({
        name: "nginx",
        namespace: "web",
        metadata: { context: "prod", kubeConfig: "/k" },
      })
    ).toBe("prod/web/nginx");
  });

  test("returns null for rows without context (e.g. log lines)", () => {
    expect(getRowIdentity({ message: "hello", name: "logger" })).toBeNull();
    expect(getRowIdentity(null)).toBeNull();
    expect(getRowIdentity("x")).toBeNull();
  });
});

describe("tab ids and titles", () => {
  const pod = {
    kind: "Pod",
    metadata: { name: "web-0", namespace: "default", context: "prod" },
  };

  test("include context, namespace, kind and name", () => {
    expect(getResourceTabId("logs", pod)).toBe("logs/prod/default/Pod/web-0");
    expect(getResourceTabId("logs", pod, "app")).toBe(
      "logs/prod/default/Pod/web-0/app"
    );
  });

  test("differ for equally named objects in other contexts / kinds", () => {
    const other = { ...pod, metadata: { ...pod.metadata, context: "dev" } };
    const deployment = { ...pod, kind: "Deployment" };
    expect(getResourceTabId("edit", pod)).not.toBe(
      getResourceTabId("edit", other)
    );
    expect(getResourceTabId("edit", pod)).not.toBe(
      getResourceTabId("edit", deployment)
    );
  });

  test("titles include the kind", () => {
    expect(getResourceTabTitle(pod)).toBe("pod/web-0");
    expect(getResourceTabTitle(pod, "app")).toBe("pod/web-0/app");
    expect(getResourceTabTitle({ name: "nginx" })).toBe("nginx");
  });
});

describe("describeRows", () => {
  test("lists names, adding context / namespace only when they differ", () => {
    expect(
      describeRows([
        { kind: "Pod", metadata: { name: "a", namespace: "x", context: "c" } },
        { kind: "Pod", metadata: { name: "b", namespace: "x", context: "c" } },
      ])
    ).toEqual(["pod/a", "pod/b"]);

    expect(
      describeRows([
        { kind: "Pod", metadata: { name: "a", namespace: "x", context: "c1" } },
        { kind: "Pod", metadata: { name: "a", namespace: "y", context: "c2" } },
      ])
    ).toEqual(["pod/a (c1 › x)", "pod/a (c2 › y)"]);
  });

  test("truncates long lists", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ name: `r${i}` }));
    const lines = describeRows(rows, 10);
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("… and 2 more");
  });
});

describe("resolveCreateTarget", () => {
  const mapping = new Map([["prod", "/prod.yaml"]]);

  test("uses the single active namespace of the primary context", () => {
    expect(
      resolveCreateTarget("prod", "/fallback", new Map([["prod", ["web"]]]), mapping)
    ).toEqual({ context: "prod", namespace: "web", kubeConfig: "/prod.yaml" });
  });

  test("leaves the namespace to the manifest with several or all namespaces", () => {
    expect(
      resolveCreateTarget("prod", "", new Map([["prod", ["a", "b"]]]), mapping)
        .namespace
    ).toBe("");
    expect(
      resolveCreateTarget("prod", "", new Map([["prod", ["all"]]]), mapping)
        .namespace
    ).toBe("");
  });

  test("falls back to the primary kubeconfig", () => {
    expect(
      resolveCreateTarget("dev", "/fallback", new Map(), mapping).kubeConfig
    ).toBe("/fallback");
  });
});

const pod = (overrides: Partial<V1Pod> = {}): V1Pod => ({
  metadata: { name: "p" },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
  status: { phase: "Running" },
  ...overrides,
});

describe("pod status", () => {
  test("Terminating wins", () => {
    expect(
      getPodStatus(pod({ metadata: { deletionTimestamp: new Date() } }))
    ).toBe("Terminating");
  });

  test("container waiting / terminated reasons", () => {
    expect(
      getPodStatus(
        pod({
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: "app",
                image: "",
                imageID: "",
                ready: false,
                restartCount: 3,
                state: { waiting: { reason: "CrashLoopBackOff" } },
              },
            ],
          },
        })
      )
    ).toBe("CrashLoopBackOff");
  });

  test("init containers", () => {
    expect(
      getPodStatus(
        pod({
          status: {
            phase: "Pending",
            initContainerStatuses: [
              {
                name: "init",
                image: "",
                imageID: "",
                ready: false,
                restartCount: 0,
                state: { running: {} },
              },
            ],
          },
        })
      )
    ).toBe("Init:0/1");
  });

  test("falls back to reason and phase", () => {
    expect(getPodStatus(pod({ status: { phase: "Failed", reason: "Evicted" } }))).toBe(
      "Evicted"
    );
    expect(getPodStatus(pod({ status: { phase: "Succeeded" } }))).toBe("Succeeded");
    expect(getPodStatus(pod({ status: {} }))).toBe("Unknown");
  });

  test.each([
    ["Running", "success"],
    ["CrashLoopBackOff", "destructive"],
    ["ImagePullBackOff", "destructive"],
    ["OOMKilled", "destructive"],
    ["Error", "destructive"],
    ["Init:CrashLoopBackOff", "destructive"],
    ["Pending", "warning"],
    ["ContainerCreating", "warning"],
    ["Init:0/1", "warning"],
    ["Completed", "muted"],
    ["Succeeded", "muted"],
    ["Something", "none"],
  ])("%s -> %s", (status, tone) => {
    expect(getPodStatusTone(status)).toBe(tone);
  });

  test("readiness without container statuses uses the spec", () => {
    expect(getPodReadiness(pod({ status: { phase: "Pending" } }))).toEqual({
      ready: 0,
      total: 2,
    });
    expect(getPodReadinessTone(pod({ status: { phase: "Pending" } }))).toBe(
      "warning"
    );
    expect(getPodReadinessTone(pod({ status: { phase: "Succeeded" } }))).toBe(
      "muted"
    );
  });

  test("restarts", () => {
    expect(getPodRestarts(pod())).toBe(0);
    expect(getRestartsTone(0)).toBe("none");
    expect(getRestartsTone(2)).toBe("warning");
  });
});

describe("node status", () => {
  const node = (readyStatus: string | null, unschedulable = false): V1Node => ({
    spec: { unschedulable, taints: [{ key: "x", effect: "NoSchedule" }] },
    status: {
      conditions: [
        ...(readyStatus ? [{ type: "Ready", status: readyStatus }] : []),
        { type: "PIDPressure", status: "False" },
      ],
    },
  });

  test("derives from the Ready condition status, not the last condition", () => {
    expect(getNodeStatus(node("True"))).toBe("Ready");
    expect(getNodeStatus(node("False"))).toBe("NotReady");
    expect(getNodeStatus(node(null))).toBe("Unknown");
  });

  test("SchedulingDisabled comes from spec.unschedulable, not taints", () => {
    expect(getNodeStatus(node("True", true))).toBe("Ready,SchedulingDisabled");
  });

  test("tones", () => {
    expect(getNodeStatusTone("Ready")).toBe("success");
    expect(getNodeStatusTone("Ready,SchedulingDisabled")).toBe("warning");
    expect(getNodeStatusTone("NotReady")).toBe("destructive");
  });
});

describe("deployment readiness", () => {
  test("ready / desired replicas", () => {
    expect(
      getDeploymentReadiness({
        spec: { replicas: 3, selector: {}, template: {} },
        status: { readyReplicas: 1, replicas: 3 },
      })
    ).toEqual({ ready: 1, total: 3 });
    expect(getReplicaTone(1, 3)).toBe("warning");
    expect(getReplicaTone(3, 3)).toBe("none");
    expect(getReplicaTone(0, 0)).toBe("muted");
  });
});

describe("events", () => {
  const event = (fields: Partial<CoreV1Event>): CoreV1Event => ({
    involvedObject: {},
    metadata: { creationTimestamp: new Date("2024-01-01T00:00:00Z") },
    ...fields,
  });

  test("last seen prefers lastTimestamp, then eventTime, then creation", () => {
    expect(
      getEventLastSeen(
        event({ lastTimestamp: new Date("2024-01-03T00:00:00Z") })
      )?.toISOString()
    ).toBe("2024-01-03T00:00:00.000Z");
    expect(
      getEventLastSeen(
        event({ eventTime: new Date("2024-01-02T00:00:00Z") })
      )?.toISOString()
    ).toBe("2024-01-02T00:00:00.000Z");
    expect(getEventLastSeen(event({}))?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z"
    );
  });

  test("warnings are highlighted", () => {
    expect(getEventTypeTone("Warning")).toBe("warning");
    expect(getEventTypeTone("Normal")).toBe("none");
  });
});

describe("age", () => {
  test("toDate handles strings, dates and garbage", () => {
    expect(toDate("2024-01-01T00:00:00Z")?.getTime()).toBe(
      Date.UTC(2024, 0, 1)
    );
    expect(toDate(null)).toBeNull();
    expect(toDate("not a date")).toBeNull();
  });

  test("formatAge", () => {
    const now = new Date("2024-01-02T01:00:00Z");
    expect(formatAge("2024-01-01T00:00:00Z", now)).toBe("1d1h");
    expect(formatAge(undefined, now)).toBe("-");
  });
});

describe("describeFailures", () => {
  test("no failures", () => {
    expect(describeFailures([], 2)).toBeNull();
  });

  test("all contexts failed is fatal", () => {
    expect(describeFailures([{ context: "a", reason: new Error("boom") }], 1)).toEqual(
      { fatal: true, message: "boom" }
    );
    expect(
      describeFailures(
        [
          { context: "a", reason: "x" },
          { context: "b", reason: "y" },
        ],
        2
      )?.fatal
    ).toBe(true);
  });

  test("partial failures are not fatal", () => {
    expect(describeFailures([{ context: "a", reason: "nope" }], 2)).toEqual({
      fatal: false,
      message: "Failed to load from a: nope",
    });
  });
});
