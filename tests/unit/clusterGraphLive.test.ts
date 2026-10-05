import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

import { effectScope, nextTick, ref } from "vue";
import { createDiscoveryService, toDiscoveredResource } from "@/lib/discovery";
import type { WatchMessage, WatchRequest, WatchTransport } from "@/lib/watch";
import { clearWatchedListCache } from "@/composables/useWatchedList";
import {
  GraphScope,
  useClusterTopology,
} from "@/composables/useClusterTopology";
import {
  GraphObject,
  buildTopology,
  reconcileTopology,
} from "@/lib/clusterGraph";
import {
  SECRET_METADATA_TEMPLATE,
  graphResourcesOf,
  namespaceTargets,
  parseLabelOutput,
  parseSecretMetadata,
  prepareListed,
  secretMetadataArgs,
} from "@/lib/clusterGraphSources";

/* ------------------------------------------------------------ fixtures -- */

const labels = { "app.kubernetes.io/name": "web" };

const deployment = (available = 2, rv = "1"): GraphObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", uid: "deploy-web", resourceVersion: rv, labels },
  spec: {
    replicas: 2,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          {
            name: "app",
            env: [{ name: "DB", valueFrom: { secretKeyRef: { name: "web-db", key: "url" } } }],
          },
        ],
      },
    },
  },
  status: { availableReplicas: available, readyReplicas: available },
});

const service = (): GraphObject => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "web", namespace: "shop", uid: "svc-web", resourceVersion: "1" },
  spec: { selector: labels },
});

const configMap = (name: string, rv = "1"): GraphObject => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name, namespace: "shop", uid: `cm-${name}`, resourceVersion: rv },
  data: { key: "value" },
});

const SECRET_LINE = [
  "secret-uid",
  "shop",
  "web-db",
  "Opaque",
  "7",
  "2026-01-01T00:00:00Z",
  '{"app.kubernetes.io/name":"web"}',
  "",
].join("\t");

/* ----------------------------------------------------------- transport -- */

function fakeTransport(options: { fail?: (request: WatchRequest) => boolean } = {}) {
  const subscribers = new Map<string, (message: WatchMessage<GraphObject>) => void>();
  const requests: WatchRequest[] = [];
  const transport: WatchTransport = {
    async subscribe<T>(request: WatchRequest, onMessage: (m: WatchMessage<T>) => void) {
      requests.push(request);
      if (options.fail?.(request)) throw new Error("cannot watch");
      subscribers.set(request.resource, onMessage as any);
      const scopes = request.namespaces.includes("all") ? [""] : [...request.namespaces].sort();
      return {
        subscription: { id: requests.length, scopes, namespaced: true, apiVersion: "v1", kind: request.kind || "" },
        unsubscribe: () => subscribers.delete(request.resource),
        restart: async () => {},
      };
    },
  };
  const snapshot = (resource: string, items: GraphObject[], scope = "") => {
    const emit = subscribers.get(resource);
    if (!emit) return;
    emit({ type: "status", scope, state: "ready" });
    emit({ type: "snapshot", scope, items });
  };
  const delta = (resource: string, change: { added?: GraphObject[]; modified?: GraphObject[]; deleted?: string[] }) =>
    subscribers.get(resource)!({
      type: "delta",
      scope: "",
      added: change.added || [],
      modified: change.modified || [],
      deleted: change.deleted || [],
    });
  return { transport, requests, subscribers, snapshot, delta };
}

const RESOURCES = [
  toDiscoveredResource({ name: "pods", kind: "Pod", namespaced: true }, "v1"),
  toDiscoveredResource({ name: "services", kind: "Service", namespaced: true }, "v1"),
  toDiscoveredResource({ name: "configmaps", kind: "ConfigMap", namespaced: true }, "v1"),
  toDiscoveredResource({ name: "secrets", kind: "Secret", namespaced: true }, "v1"),
  toDiscoveredResource({ name: "nodes", kind: "Node", namespaced: false }, "v1"),
  toDiscoveredResource({ name: "persistentvolumes", kind: "PersistentVolume", namespaced: false }, "v1"),
];
const APPS = [
  toDiscoveredResource({ name: "deployments", kind: "Deployment", namespaced: true }, "apps/v1"),
];

function discovery() {
  return createDiscoveryService({
    fetcher: async () => ({ groups: { v1: RESOURCES, apps: APPS } }),
  });
}

/* Waits for timers + microtasks (coalesced builds). */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};

function mount(
  transport: WatchTransport,
  kubectl: (args: string[]) => Promise<string>,
  options: { forcePolling?: boolean; scope?: GraphScope } = {}
) {
  const scope = effectScope();
  const graph = scope.run(() =>
    useClusterTopology(
      ref<GraphScope | null>(
        options.scope ?? { context: "prod", kubeConfig: "/kc", namespaces: [] }
      ),
      {
        transport,
        kubectl,
        discovery: discovery(),
        forcePolling: () => options.forcePolling ?? false,
        pollInterval: 60_000,
      }
    )
  )!;
  return { graph, stop: () => scope.stop() };
}

afterEach(() => {
  clearWatchedListCache();
  vi.useRealTimers();
});

/* --------------------------------------------------------------- tests -- */

describe("graph sources", () => {
  test("picks the graphable kinds of a discovery snapshot", () => {
    const resources = graphResourcesOf({
      context: "prod",
      kubeConfig: "",
      fetchedAt: 0,
      groups: { v1: RESOURCES, apps: APPS },
    });
    expect(resources.map((r) => r.name)).toEqual([
      "pods",
      "services",
      "configmaps",
      "secrets",
      "persistentvolumes",
      "deployments",
    ]);
  });

  test("watches a few namespaces separately, many as one scope", () => {
    expect(namespaceTargets({ namespaced: true }, [])).toEqual(["all"]);
    expect(namespaceTargets({ namespaced: true }, ["b", "a"])).toEqual(["a", "b"]);
    expect(namespaceTargets({ namespaced: true }, ["a", "b", "c", "d", "e"])).toEqual(["all"]);
    expect(namespaceTargets({ namespaced: false }, ["a"])).toEqual(["all"]);
  });

  test("lists secrets metadata-only", () => {
    const args = secretMetadataArgs("prod", "/kc", "shop");
    expect(args).toEqual(
      expect.arrayContaining(["get", "secrets", "-o", SECRET_METADATA_TEMPLATE, "--namespace", "shop"])
    );
    expect(SECRET_METADATA_TEMPLATE).not.toContain(".data");
    const [secret] = parseSecretMetadata(`${SECRET_LINE}\n`, { context: "prod", kubeConfig: "/kc" });
    expect(secret).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        uid: "secret-uid",
        name: "web-db",
        namespace: "shop",
        resourceVersion: "7",
        creationTimestamp: "2026-01-01T00:00:00Z",
        labels: { "app.kubernetes.io/name": "web" },
        context: "prod",
        kubeConfig: "/kc",
      },
    });
    expect("data" in secret).toBe(false);
  });

  test("parses old map[] label output", () => {
    expect(parseLabelOutput("map[app:web tier:db]")).toEqual({ app: "web", tier: "db" });
    expect(parseLabelOutput("")).toEqual({});
  });

  test("strips secret values from listed rows", () => {
    const [secret] = prepareListed(
      [{ metadata: { name: "s", managedFields: [{}] }, data: { a: "c2VjcmV0" } } as any],
      { name: "secrets", group: "", kind: "Secret" },
      { context: "prod", kubeConfig: "" }
    );
    expect(secret.kind).toBe("Secret");
    expect(secret.data).toBeUndefined();
    expect(secret.metadata.managedFields).toBeUndefined();
  });
});

describe("reconcileTopology", () => {
  test("keeps unchanged nodes and reports status-only changes", () => {
    // Unchanged rows keep their identity (the watched lists guarantee it).
    const unchanged = [service(), configMap("a")];
    const first = buildTopology([deployment(2), ...unchanged]);
    const second = buildTopology([deployment(1, "2"), ...unchanged]);
    const { topology, change } = reconcileTopology(first, second);
    expect(change.structure).toBe(false);
    expect([...change.nodes]).toEqual(["deploy-web"]);
    expect(topology.nodes.get("cm-a")).toBe(first.nodes.get("cm-a"));
    expect(topology.nodes.get("deploy-web")).not.toBe(first.nodes.get("deploy-web"));
    expect(topology.edges).toBe(first.edges);
  });

  test("returns the previous model when nothing changed", () => {
    const objects = [deployment(2), service()];
    const first = buildTopology(objects);
    const { topology, change } = reconcileTopology(first, buildTopology(objects));
    expect(topology).toBe(first);
    expect(change.nodes.size).toBe(0);
  });

  test("reports added and removed objects as a structure change", () => {
    const web = deployment(2);
    const first = buildTopology([web, configMap("a")]);
    const { change } = reconcileTopology(first, buildTopology([web, configMap("b")]));
    expect(change.structure).toBe(true);
    expect([...change.removed]).toEqual(["cm-a"]);
    expect(change.nodes.has("cm-b")).toBe(true);
  });
});

describe("useClusterTopology", () => {
  test("watches every graphable kind and builds once all are synced", async () => {
    const watch = fakeTransport();
    const kubectl = vi.fn(async (args: string[]) => (args[1] === "secrets" ? SECRET_LINE : "{}"));
    const { graph, stop } = mount(watch.transport, kubectl);
    await settle();

    expect(watch.requests.map((r) => r.resource).sort()).toEqual([
      "configmaps",
      "deployments.apps",
      "persistentvolumes",
      "pods",
      "services",
    ]);
    // Secrets: metadata-only kubectl list, never a (full object) watch.
    expect(kubectl).toHaveBeenCalledTimes(1);
    expect(kubectl.mock.calls[0][0]).toContain(SECRET_METADATA_TEMPLATE);

    watch.snapshot("deployments.apps", [deployment()]);
    watch.snapshot("services", [service()]);
    watch.snapshot("configmaps", [configMap("a")]);
    await settle();
    expect(graph.topology.value).toBeNull();
    expect(graph.progress.value).toEqual({ done: 4, total: 6 });

    watch.snapshot("pods", []);
    watch.snapshot("persistentvolumes", []);
    await settle();
    const topology = graph.topology.value!;
    expect(topology.nodes.get("deploy-web")?.health).toBe("ok");
    expect(topology.nodes.get("secret-uid")?.object?.data).toBeUndefined();
    // The secret is referenced by the deployment: an edge, not a missing node.
    expect(topology.edges.some((e) => e.target === "secret-uid")).toBe(true);
    expect(graph.loading.value).toBe(false);
    expect(graph.mode.value).toBe("watch");
    stop();
  });

  test("applies deltas incrementally", async () => {
    const watch = fakeTransport();
    const { graph, stop } = mount(watch.transport, async () => "");
    await settle();
    for (const resource of ["pods", "services", "persistentvolumes"]) watch.snapshot(resource, []);
    watch.snapshot("configmaps", [configMap("a")]);
    watch.snapshot("deployments.apps", [deployment(0)]);
    await settle();
    const first = graph.topology.value!;
    expect(graph.timings.value?.builds).toBe(1);

    // Status only: the model changes, its structure does not.
    watch.delta("deployments.apps", { modified: [deployment(2, "2")] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = graph.topology.value!;
    expect(second).not.toBe(first);
    expect(graph.change.value?.structure).toBe(false);
    expect(second.nodes.get("cm-a")).toBe(first.nodes.get("cm-a"));

    // A re-sent snapshot with the same versions changes nothing.
    watch.snapshot("configmaps", [configMap("a")]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(graph.topology.value).toBe(second);

    // Added + removed objects.
    watch.delta("configmaps", { added: [configMap("b")], deleted: ["cm-a"] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(graph.change.value?.structure).toBe(true);
    expect(graph.change.value?.removed.has("cm-a")).toBe(true);
    expect(graph.topology.value!.nodes.has("cm-b")).toBe(true);
    stop();
  });

  test("falls back to kubectl per kind when a watch cannot start", async () => {
    const watch = fakeTransport({ fail: (request) => request.resource === "configmaps" });
    const kubectl = vi.fn(async (args: string[]) =>
      args[1] === "configmaps"
        ? JSON.stringify({ items: [{ ...configMap("a"), kind: undefined }] })
        : ""
    );
    const { graph, stop } = mount(watch.transport, kubectl);
    await settle();
    for (const resource of ["pods", "services", "persistentvolumes", "deployments.apps"]) {
      watch.snapshot(resource, []);
    }
    await settle();
    expect(kubectl.mock.calls.some((call) => call[0][1] === "configmaps")).toBe(true);
    expect(graph.topology.value?.nodes.get("cm-a")?.kind).toBe("ConfigMap");
    expect(graph.mode.value).toBe("mixed");
    stop();
  });

  test("polls everything with kubectl when forced", async () => {
    const watch = fakeTransport();
    const kubectl = vi.fn(async (args: string[]) =>
      args[1] === "secrets" ? "" : JSON.stringify({ items: [] })
    );
    const { graph, stop } = mount(watch.transport, kubectl, { forcePolling: true });
    await settle();
    expect(watch.requests).toHaveLength(0);
    expect(kubectl).toHaveBeenCalledTimes(6);
    expect(graph.topology.value).not.toBeNull();
    expect(graph.mode.value).toBe("poll");
    stop();
  });

  test("watches a selection of namespaces per namespace", async () => {
    const watch = fakeTransport();
    const { stop } = mount(watch.transport, async () => "", {
      scope: { context: "prod", kubeConfig: "/kc", namespaces: ["shop", "admin"] },
    });
    await settle();
    const pods = watch.requests.find((r) => r.resource === "pods")!;
    expect(pods.namespaces).toEqual(["admin", "shop"]);
    const volumes = watch.requests.find((r) => r.resource === "persistentvolumes")!;
    expect(volumes.namespaces).toEqual(["all"]);
    stop();
  });

  test("unsubscribes when disposed", async () => {
    const watch = fakeTransport();
    const { stop } = mount(watch.transport, async () => "");
    await settle();
    expect(watch.subscribers.size).toBe(5);
    stop();
    expect(watch.subscribers.size).toBe(0);
  });
});
