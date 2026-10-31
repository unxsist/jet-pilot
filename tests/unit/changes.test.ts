import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { diffFields, sides } from "@/lib/changes/fields";
import {
  eventWords,
  fieldPhrase,
  fieldWords,
  helmWords,
  keyWords,
  managedWords,
  managerLabel,
  restartWords,
  shortImage,
  shortRevision,
} from "@/lib/changes/words";
import {
  fromControllerRevisions,
  fromEvents,
  fromHelmHistory,
  fromManagedFields,
  fromNodes,
  fromPods,
  fromRecords,
  fromReplicaSets,
  type Window,
} from "@/lib/changes/sources";
import { dayTitle, groupByDay, matchesChange, mergeChanges, type Change } from "@/lib/changes/model";
import { causeSummary, likelyCause, pickCause } from "@/lib/changes/cause";

const NOW = Date.parse("2026-10-31T15:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const WINDOW: Window = { from: NOW - 14 * 86_400_000, to: NOW + 60_000 };
const target = { context: "prod", kubeConfig: "/kc" };

const template = (image: string, extra: Record<string, unknown> = {}) => ({
  metadata: { labels: { app: "checkout-api", "pod-template-hash": Math.random().toString(36).slice(2, 8) } },
  spec: { containers: [{ name: "api", image, env: [{ name: "LOG_LEVEL", value: "info" }], ...extra }] },
});

const replicaSet = (revision: number, image: string, minutesAgo: number, extra: Record<string, unknown> = {}, annotations = {}) => ({
  metadata: {
    name: `checkout-api-${revision}`,
    namespace: "checkout",
    uid: `rs-${revision}`,
    creationTimestamp: iso(minutesAgo),
    annotations: { "deployment.kubernetes.io/revision": String(revision), ...annotations },
    ownerReferences: [{ kind: "Deployment", name: "checkout-api", uid: "dep-1", controller: true }],
  },
  spec: { template: template(image, extra) },
});

describe("field diffs", () => {
  it("matches named lists by name and rebuilds both sides", () => {
    const fields = diffFields(
      { containers: [{ name: "api", image: "a:1" }, { name: "envoy", image: "e:1" }] },
      { containers: [{ name: "envoy", image: "e:1" }, { name: "api", image: "a:2" }] }
    );
    expect(fields).toEqual([{ path: ["containers", "[api]", "image"], from: "a:1", to: "a:2" }]);
    expect(sides(fields)).toEqual({ before: { containers: { api: { image: "a:1" } } }, after: { containers: { api: { image: "a:2" } } } });
  });
});

describe("words", () => {
  const words = (path: string[], from?: unknown, to?: unknown) => fieldPhrase({ path, from, to }).text;

  it("puts pod template changes in plain words", () => {
    const container = ["template", "spec", "containers", "[api]"];
    expect(words([...container, "image"], "ghcr.io/acme/api:1.4.2", "ghcr.io/acme/api:1.5.0")).toBe("image api:1.4.2 → api:1.5.0");
    expect(words([...container, "env", "[LOG_LEVEL]", "value"], "info", "debug")).toBe("env LOG_LEVEL changed");
    expect(words([...container, "env", "[NEW]"], undefined, { name: "NEW", value: "x" })).toBe("env NEW added");
    expect(words([...container, "resources", "limits", "memory"], "256Mi", "512Mi")).toBe("memory limit 256Mi → 512Mi");
    expect(words([...container, "readinessProbe", "httpGet", "path"], "/a", "/b")).toBe("readiness probe changed");
    expect(words([...container, "envFrom"], [{ configMapRef: { name: "flags-v1" } }], [{ configMapRef: { name: "flags-v2" } }])).toBe(
      "ConfigMap flags-v1 → flags-v2"
    );
    expect(words(["template", "spec", "volumes", "[config]", "configMap", "name"], "a", "b")).toBe("ConfigMap a → b");
    expect(words(["template", "metadata", "annotations", "kubectl.kubernetes.io/restartedAt"], undefined, "2026")).toBe("restarted");
    expect(words(["replicas"], 3, 5)).toBe("replicas 3 → 5");
    expect(words(["unschedulable"], undefined, true)).toBe("cordoned");
    expect(words(["taints"], [], [{ key: "gpu", effect: "NoSchedule" }])).toBe("taint gpu added");
    expect(words(["template", "spec", "serviceAccountName"], "a", "b")).toBe("service account name changed");
    expect(words(["metadata", "labels", "app.kubernetes.io/version"], "1", "2")).toBe("pod labels changed");
  });

  it("never shows env or Helm values", () => {
    const env = fieldPhrase({ path: ["template", "spec", "containers", "[api]", "env", "[DB_PASSWORD]", "value"], from: "hunter2", to: "s3cret" });
    expect(env.text).not.toMatch(/hunter2|s3cret/);
    const helm = helmWords(
      { revision: 1, chartVersion: "1.0.0", values: { db: { password: "a" } } },
      { revision: 2, chartVersion: "1.0.0", values: { db: { password: "b" } } },
      diffFields
    );
    expect(helm.text).toBe("values db.password changed");
  });

  it("joins phrases and gives a sentence", () => {
    const fields = [
      { path: ["template", "spec", "containers", "[api]", "image"], from: "api:1", to: "api:2" },
      { path: ["template", "spec", "containers", "[api]", "env", "[A]", "value"], from: "1", to: "2" },
      { path: ["replicas"], from: 1, to: 2 },
    ];
    const joined = fieldWords(fields);
    expect(joined.text).toBe("image api:1 → api:2, env A changed and 1 more");
    expect(joined.sentence).toBe("Image changed from api:1 to api:2, env A changed and 1 more");
  });

  it("names keys, never values, of ConfigMaps and Secrets", () => {
    expect(keyWords("Secret", "db", { changed: ["password"] }).text).toBe("password changed");
    expect(keyWords("ConfigMap", "flags", { added: ["a", "b"] }).text).toBe("a and b added");
    expect(keyWords("ConfigMap", "flags", { changed: ["a", "b", "c", "d"] }).text).toBe("4 keys changed");
  });

  it("reads what a field manager owns", () => {
    expect(managedWords("Deployment", { "f:spec": { "f:replicas": {} } })?.text).toBe("changed replicas");
    expect(
      managedWords("Deployment", {
        "f:spec": { "f:template": { "f:metadata": { "f:annotations": { "f:kubectl.kubernetes.io/restartedAt": {} } } } },
      })?.text
    ).toBe("restarted");
    expect(
      managedWords("Deployment", {
        "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"api"}': { "f:image": {}, "f:env": {} } } } } },
      })?.text
    ).toBe("changed image and env");
    expect(managedWords("ConfigMap", { "f:data": { "f:LOG_LEVEL": {} } })?.text).toBe("changed LOG_LEVEL");
    expect(managedWords("Deployment", { "f:metadata": { "f:annotations": { "f:deployment.kubernetes.io/revision": {} } } })).toBeNull();
    expect(managerLabel("kubectl-edit")).toBe("kubectl edit");
    expect(managerLabel("custom-operator")).toBe("custom-operator");
  });

  it("words events, restarts and revisions", () => {
    expect(
      eventWords({ reason: "SuccessfulRescale", message: "New size: 5; reason: cpu resource utilization (percentage of request) above target" }).text
    ).toBe("scaled to 5 (cpu above target)");
    expect(eventWords({ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container api", count: 61 }).text).toBe(
      "Back-off restarting failed container api (61 times)"
    );
    expect(restartWords({ reason: "OOMKilled", exitCode: 137 }, 4).text).toBe("restarted after running out of memory · 4 restarts");
    expect(restartWords({ reason: "Error", exitCode: 1 }, 1).text).toBe("restarted after exiting with code 1");
    expect(shortImage("registry.k8s.io/coredns/coredns@sha256:1234567890abcdef")).toBe("coredns@1234567");
    expect(shortRevision("main@sha1:4f1e2d3c5b6a79880011223344556677")).toBe("main@4f1e2d3");
    expect(shortRevision("4f1e2d3c5b6a798800112233445566778899aabb")).toBe("4f1e2d3");
    expect(shortRevision("61.3.2")).toBe("61.3.2");
  });
});

describe("reconstruction", () => {
  it("turns ReplicaSet revisions into rollouts with a template diff", () => {
    const changes = fromReplicaSets(
      target,
      [replicaSet(5, "ghcr.io/acme/checkout-api:v3.1.4", 3 * 24 * 60), replicaSet(6, "ghcr.io/acme/checkout-api:v3.2.0", 12)],
      WINDOW
    );
    expect(changes).toHaveLength(1);
    const [rollout] = changes;
    expect(rollout.object).toMatchObject({ kind: "Deployment", name: "checkout-api", namespace: "checkout", uid: "dep-1" });
    expect(rollout.summary).toBe("image checkout-api:v3.1.4 → checkout-api:v3.2.0");
    expect(rollout.kind).toBe("template");
    expect(rollout.diff?.afterLabel).toBe("Revision 6");
    expect(JSON.stringify(rollout.diff)).not.toContain("pod-template-hash");
  });

  it("skips ReplicaSets a rollback reused (their creation isn't the rollback)", () => {
    const reused = replicaSet(7, "ghcr.io/acme/checkout-api:v3.1.4", 3 * 24 * 60, {}, { "deployment.kubernetes.io/revision-history": "5" });
    expect(fromReplicaSets(target, [replicaSet(6, "x:2", 60), reused], WINDOW)).toHaveLength(0);
  });

  it("reads StatefulSet ControllerRevisions", () => {
    const revision = (n: number, image: string, minutesAgo: number) => ({
      metadata: { uid: `cr-${n}`, namespace: "payments", creationTimestamp: iso(minutesAgo), ownerReferences: [{ kind: "StatefulSet", name: "postgres", uid: "sts", controller: true }] },
      revision: n,
      data: { spec: { template: { $patch: "replace", spec: { containers: [{ name: "postgres", image }] } } } },
    });
    const [change] = fromControllerRevisions(target, [revision(1, "postgres:16.2", 9000), revision(2, "postgres:16.3", 30)], WINDOW);
    expect(change.summary).toBe("image postgres:16.2 → postgres:16.3");
    expect(JSON.stringify(change.diff)).not.toContain("$patch");
  });

  it("reads Helm history with chart and value paths", () => {
    const changes = fromHelmHistory(
      target,
      { name: "checkout", namespace: "checkout" },
      [
        { revision: 16, status: "superseded", chart: "checkout", chartVersion: "3.1.4", updated: iso(3000), values: { image: { tag: "v3.1.4" } } },
        { revision: 17, status: "failed", chart: "checkout", chartVersion: "3.2.0", updated: iso(15), values: { image: { tag: "v3.2.0" }, replicaCount: 3 } },
      ],
      WINDOW
    );
    expect(changes.map((c) => c.summary)).toEqual([
      "installed checkout 3.1.4",
      "chart 3.1.4 → 3.2.0, values image.tag and replicaCount changed · failed",
    ]);
    expect(changes[1].tone).toBe("destructive");
  });

  it("reads managedFields writes and creations", () => {
    const changes = fromManagedFields(
      target,
      "Deployment",
      [
        {
          metadata: {
            name: "checkout-api",
            namespace: "checkout",
            uid: "dep-1",
            creationTimestamp: iso(60 * 24 * 30),
            managedFields: [
              { manager: "helm", operation: "Update", time: iso(60 * 24 * 30), fieldsV1: { "f:spec": { "f:template": {} } } },
              { manager: "kubectl-edit", operation: "Update", time: iso(40), fieldsV1: { "f:spec": { "f:replicas": {} } } },
              { manager: "kube-controller-manager", operation: "Update", subresource: "scale", time: iso(20), fieldsV1: { "f:spec": { "f:replicas": {} } } },
              { manager: "kube-controller-manager", operation: "Update", subresource: "status", time: iso(1), fieldsV1: { "f:status": {} } },
            ],
          },
        },
      ],
      WINDOW
    );
    expect(changes.map((c) => [c.summary, c.by, c.kind])).toEqual([
      ["changed replicas", "kubectl-edit", "scale"],
      ["changed replicas", "horizontal-pod-autoscaler", "scale"],
    ]);
  });

  it("reads restarts, node transitions and events", () => {
    const [restart] = fromPods(
      target,
      [{ metadata: { name: "p", namespace: "a", uid: "p" }, status: { containerStatuses: [{ name: "c", restartCount: 3, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: iso(5) } } }] } }],
      WINDOW
    );
    expect(restart).toMatchObject({ kind: "crash", tone: "warning", summary: "restarted after running out of memory · 3 restarts" });

    const node = (transition: number) => ({
      metadata: { name: "n1", uid: "n1", creationTimestamp: iso(60 * 24 * 20) },
      status: { conditions: [{ type: "DiskPressure", status: "True", lastTransitionTime: iso(transition) }, { type: "Ready", status: "True", lastTransitionTime: iso(60 * 24 * 20 - 1) }] },
    });
    const conditions = fromNodes(target, [node(120)], WINDOW);
    expect(conditions.map((c) => c.summary)).toEqual(["under disk pressure"]);

    const events = fromEvents(
      target,
      [
        { metadata: { uid: "e1", namespace: "a" }, involvedObject: { kind: "Pod", name: "p" }, type: "Warning", reason: "BackOff", message: "Back-off", lastTimestamp: iso(2) },
        { metadata: { uid: "e2", namespace: "a" }, involvedObject: { kind: "Pod", name: "p" }, type: "Normal", reason: "Pulled", message: "Pulled", lastTimestamp: iso(2) },
        { metadata: { uid: "e3", namespace: "a" }, involvedObject: { kind: "HorizontalPodAutoscaler", name: "h" }, type: "Normal", reason: "SuccessfulRescale", message: "New size: 4; reason: All metrics below target", lastTimestamp: iso(3) },
      ],
      WINDOW
    );
    expect(events.map((e) => [e.key, e.kind])).toEqual([
      ["event:e1", "event"],
      ["event:e3", "scale"],
    ]);
  });

  it("reads the recorder's records", () => {
    const changes = fromRecords(target, [
      { id: "u1:9", at: iso(5), kind: "Deployment", name: "d", namespace: "a", uid: "u1", action: "updated", by: "kubectl-edit", fields: [{ path: ["replicas"], from: 2, to: 4 }] },
      { id: "s:1", at: iso(4), kind: "Secret", name: "db", namespace: "a", uid: "s", action: "updated", keys: { changed: ["password"] } },
      { id: "event:e1", at: iso(3), kind: "Pod", name: "p", namespace: "a", action: "event", event: { type: "Warning", reason: "BackOff", message: "Back-off", count: 2 } },
    ]);
    expect(changes.map((c) => [c.key, c.kind, c.summary, c.recorded])).toEqual([
      ["rec:u1:9", "scale", "replicas 2 → 4", true],
      ["rec:s:1", "config", "password changed", true],
      ["event:e1", "event", "Back-off (2 times)", true],
    ]);
    expect(changes[0].diff).toMatchObject({ before: { replicas: 2 }, after: { replicas: 4 } });
  });
});

const change = (key: string, minutesAgo: number, extra: Partial<Change> = {}): Change => ({
  key,
  at: iso(minutesAgo),
  target,
  object: { kind: "Deployment", name: "checkout-api", namespace: "checkout", uid: "dep-1" },
  kind: "template",
  summary: key,
  sentence: key,
  source: "revisions",
  recorded: false,
  ...extra,
});

describe("merging", () => {
  it("folds the same change seen by several sources into the richest", () => {
    const merged = mergeChanges([
      change("revision", 12),
      change("recorded", 12.5, { source: "recorded", recorded: true, by: "helm" }),
      change("write", 11.8, { source: "managed-fields", by: "helm" }),
      change("scale", 5, { source: "recorded", kind: "scale", recorded: true }),
      change("event:e1", 3, { source: "recorded", kind: "event", recorded: true }),
      change("event:e1", 1, { source: "events", kind: "event", by: "kubelet" }),
    ]);
    expect(merged.map((c) => [c.key, c.by, c.recorded])).toEqual([
      ["event:e1", "kubelet", true],
      ["scale", undefined, true],
      ["revision", "helm", true],
    ]);
  });

  it("groups by day and searches", () => {
    const now = new Date(2026, 9, 31, 15);
    expect(dayTitle(new Date(2026, 9, 31, 1), now)).toBe("Today");
    expect(dayTitle(new Date(2026, 9, 30, 23), now)).toBe("Yesterday");
    expect(dayTitle(new Date(2026, 9, 28, 12), now)).toBe("Wednesday");
    expect(dayTitle(new Date(2026, 9, 20, 12), now)).toBe("20 October");
    expect(dayTitle(new Date(2025, 9, 20, 12), now)).toBe("20 October 2025");
    const days = groupByDay([change("a", 10), change("b", 20), change("c", 60 * 30)], now);
    expect(days.map((d) => d.changes.length)).toEqual([2, 1]);

    const c = change("image api:1 → api:2", 1, { by: "kubectl-edit" });
    expect(matchesChange(c, "checkout api:2")).toBe(true);
    expect(matchesChange(c, "kubectl edit")).toBe(true);
    expect(matchesChange(c, "Production", "Production EU")).toBe(true);
    expect(matchesChange(c, "payments")).toBe(false);
  });
});

describe("likely cause", () => {
  const since = NOW - 5 * 60_000;

  it("picks the newest content change before the problem", () => {
    const changes = [
      change("old image", 60 * 3, { kind: "template" }),
      change("config", 30, { kind: "config", object: { kind: "ConfigMap", name: "flags", namespace: "checkout" } }),
      change("scaled", 10, { kind: "scale" }),
      change("after", 1, { kind: "template" }),
      change("crash", 6, { kind: "crash" }),
    ];
    expect(pickCause(changes, since)?.key).toBe("config");
  });

  it("looks past a restart to the change it picked up", () => {
    const changes = [change("restart", 8, { kind: "restart" }), change("config", 40, { kind: "config" })];
    expect(pickCause(changes, since)?.key).toBe("config");
    expect(pickCause([change("restart", 8, { kind: "restart" })], since)?.key).toBe("restart");
  });

  it("ignores changes outside the window, nodes and deleted workloads", () => {
    expect(pickCause([change("days ago", 60 * 30)], since)).toBeNull();
    expect(pickCause([change("cordon", 10, { kind: "spec", object: { kind: "Node", name: "n" } })], since)).toBeNull();
    expect(pickCause([change("gone", 10, { kind: "deleted" })], since)).toBeNull();
    expect(pickCause([change("gone", 10, { kind: "deleted", object: { kind: "Secret", name: "db", namespace: "a" } })], since)?.key).toBe("gone");
  });

  it("prefers the template at the same moment", () => {
    const changes = [change("release", 10, { kind: "release" }), change("template", 10, { kind: "template" })];
    expect(pickCause(changes, since)?.key).toBe("template");
    expect(causeSummary(changes[1])).toEqual({
      at: changes[1].at,
      object: { kind: "Deployment", name: "checkout-api", namespace: "checkout" },
      summary: "template.",
    });
  });

  describe("from the cluster", () => {
    const pod = {
      kind: "Pod",
      metadata: {
        name: "checkout-api-6-abc",
        namespace: "checkout",
        uid: "pod-1",
        ownerReferences: [{ kind: "ReplicaSet", name: "checkout-api-6", uid: "rs-6", controller: true, apiVersion: "apps/v1" }],
      },
      spec: { containers: [{ name: "api", image: "ghcr.io/acme/checkout-api:v3.2.0", envFrom: [{ configMapRef: { name: "checkout-flags" } }] }] },
    };
    const deployment = {
      kind: "Deployment",
      metadata: { name: "checkout-api", namespace: "checkout", uid: "dep-1", managedFields: [] },
      spec: { selector: { matchLabels: { app: "checkout-api" } }, template: { spec: pod.spec } },
    };
    const routes: Record<string, unknown> = {
      "/api/v1/namespaces/checkout/pods/checkout-api-6-abc": pod,
      "/apis/apps/v1/namespaces/checkout/replicasets/checkout-api-6": replicaSet(6, "ghcr.io/acme/checkout-api:v3.2.0", 12),
      "/apis/apps/v1/namespaces/checkout/deployments/checkout-api": deployment,
      "/apis/apps/v1/namespaces/checkout/replicasets?labelSelector=app%3Dcheckout-api": {
        items: [replicaSet(5, "ghcr.io/acme/checkout-api:v3.1.4", 3 * 24 * 60), replicaSet(6, "ghcr.io/acme/checkout-api:v3.2.0", 12)],
      },
      "/api/v1/namespaces/checkout/configmaps/checkout-flags": {
        kind: "PartialObjectMetadata",
        metadata: {
          name: "checkout-flags",
          namespace: "checkout",
          uid: "cm-1",
          creationTimestamp: iso(60 * 24 * 90),
          managedFields: [{ manager: "kubectl-edit", operation: "Update", time: iso(60 * 5), fieldsV1: { "f:data": { "f:FAST_CHECKOUT": {} } } }],
        },
      },
    };
    const accepts: string[] = [];

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
      accepts.length = 0;
      invoke.mockReset();
      invoke.mockImplementation(async (command: string, args: any) => {
        if (command === "changes_list") return [{ context: "prod", kubeConfig: "/kc", recording: true, sessions: [], records: [] }];
        if (command === "kube_request") {
          if (args.request.path.includes("configmaps")) accepts.push(args.request.accept);
          const body = routes[args.request.path];
          if (body === undefined) throw { code: 404, message: "not found" };
          return JSON.stringify(body);
        }
        throw new Error(`unexpected ${command}`);
      });
    });

    it("walks the owner chain to the rollout that broke it", async () => {
      const cause = await likelyCause(target, { kind: "Pod", name: "checkout-api-6-abc", namespace: "checkout" }, new Date(since).toISOString());
      expect(cause).toEqual({
        at: iso(12),
        object: { kind: "Deployment", name: "checkout-api", namespace: "checkout" },
        summary: "Image changed from checkout-api:v3.1.4 to checkout-api:v3.2.0.",
      });
      expect(accepts.every((a) => a?.includes("PartialObjectMetadata"))).toBe(true);
      vi.useRealTimers();
    });

    it("finds an edited ConfigMap the pods use", async () => {
      // Before the rollout: the ConfigMap edit five hours ago is the newest change.
      const cause = await likelyCause(target, { kind: "Deployment", name: "checkout-api", namespace: "checkout" }, iso(30));
      expect(cause).toMatchObject({
        object: { kind: "ConfigMap", name: "checkout-flags" },
        summary: "ConfigMap checkout-flags: changed FAST_CHECKOUT.",
        by: "kubectl-edit",
      });
      vi.useRealTimers();
    });
  });
});
