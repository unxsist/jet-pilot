import { describe, expect, it, vi } from "vitest";
import {
  createDiscoveryService,
  findResource,
  flattenResources,
  runLimited,
  toDiscoveredResource,
  type DiscoveryFetchResult,
  type DiscoverySnapshot,
  type DiscoveryStorage,
} from "@/lib/discovery";

const pods = toDiscoveredResource(
  { name: "pods", kind: "Pod", namespaced: true, shortNames: ["po"] },
  "v1"
);
const deployments = toDiscoveredResource(
  { name: "deployments", kind: "Deployment", namespaced: true, shortNames: ["deploy"] },
  "apps/v1"
);
const crd = toDiscoveredResource(
  { name: "deployments", kind: "Deployment", namespaced: true },
  "example.com/v1"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(initial: DiscoverySnapshot[] | null = null) {
  let saved: DiscoverySnapshot[] | null = initial;
  const storage: DiscoveryStorage & { saved: () => DiscoverySnapshot[] | null } = {
    load: async () => saved,
    save: async (snapshots) => {
      saved = JSON.parse(JSON.stringify(snapshots));
    },
    saved: () => saved,
  };
  return storage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("discovery service", () => {
  it("fetches once for concurrent requests of the same context", async () => {
    const fetcher = vi.fn(async (): Promise<DiscoveryFetchResult> => ({
      groups: { v1: [pods] },
    }));
    const service = createDiscoveryService({ fetcher });

    const [a, b] = await Promise.all([
      service.load("prod", "/kube/config"),
      service.load("prod", "/kube/config"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a?.groups.v1[0].kind).toBe("Pod");
  });

  it("keeps contexts of different kubeconfigs apart", async () => {
    const fetcher = vi.fn(async (_c: string, kubeConfig: string) => ({
      groups: { v1: kubeConfig === "/a" ? [pods] : [] },
    }));
    const service = createDiscoveryService({ fetcher });

    await service.load("prod", "/a");
    await service.load("prod", "/b");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.peek("prod", "/a")?.groups.v1).toHaveLength(1);
    expect(service.peek("prod", "/b")?.groups.v1).toHaveLength(0);
  });

  it("serves fresh data from memory within the TTL and refetches after", async () => {
    let time = 1_000;
    const fetcher = vi.fn(async () => ({ groups: { v1: [pods] } }));
    const service = createDiscoveryService({ fetcher, ttlMs: 100, now: () => time });

    await service.load("prod", "/k");
    time += 50;
    await service.load("prod", "/k");
    expect(fetcher).toHaveBeenCalledTimes(1);

    time += 100;
    await service.load("prod", "/k");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders from the disk cache, then revalidates in the background", async () => {
    const cached: DiscoverySnapshot = {
      context: "prod",
      kubeConfig: "/k",
      fetchedAt: 1,
      groups: { v1: [pods] },
    };
    const pending = deferred<DiscoveryFetchResult>();
    const fetcher = vi.fn(() => pending.promise);
    const service = createDiscoveryService({
      fetcher,
      storage: memoryStorage([cached]),
      persistDebounceMs: 0,
    });
    await service.hydrated;

    const entry = service.get("prod", "/k");
    expect(entry.snapshot.value?.groups.v1).toHaveLength(1);
    await flush();
    expect(entry.status.value).toBe("revalidating");
    expect(fetcher).toHaveBeenCalledTimes(1);

    pending.resolve({ groups: { v1: [pods], apps: [deployments] } });
    await flush();
    expect(entry.status.value).toBe("fresh");
    expect(Object.keys(entry.snapshot.value!.groups)).toEqual(["v1", "apps"]);
  });

  it("persists snapshots to storage (debounced, LRU bounded)", async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn(async (context: string) => ({
      groups: { v1: [{ ...pods, name: `pods-${context}` }] },
    }));
    const service = createDiscoveryService({
      fetcher,
      storage,
      maxEntries: 2,
      persistDebounceMs: 0,
    });

    await service.load("a", "/k");
    await service.load("b", "/k");
    await service.load("c", "/k");
    await new Promise((r) => setTimeout(r, 5));

    expect(storage.saved()?.map((s) => s.context)).toEqual(["b", "c"]);
    expect(service.peek("a", "/k")).toBeNull();
  });

  it("keeps the last known groups when some groups fail", async () => {
    const fetcher = vi
      .fn<(c: string, k: string) => Promise<DiscoveryFetchResult>>()
      .mockResolvedValueOnce({ groups: { v1: [pods], apps: [deployments] } })
      .mockResolvedValueOnce({ groups: { v1: [pods] }, failedGroups: ["apps"] });
    const service = createDiscoveryService({ fetcher });

    await service.load("prod", "/k");
    const snapshot = await service.load("prod", "/k", { force: true });

    expect(snapshot?.groups.apps).toEqual([deployments]);
  });

  it("keeps the cached snapshot and reports an error when the fetch fails", async () => {
    const onError = vi.fn();
    const fetcher = vi
      .fn<(c: string, k: string) => Promise<DiscoveryFetchResult>>()
      .mockResolvedValueOnce({ groups: { v1: [pods] } })
      .mockRejectedValueOnce(new Error("Unauthorized"));
    const service = createDiscoveryService({ fetcher, onError });

    await service.load("prod", "/k");
    const snapshot = await service.load("prod", "/k", { force: true });
    const entry = service.get("prod", "/k");

    expect(snapshot?.groups.v1).toEqual([pods]);
    expect(entry.status.value).toBe("error");
    expect(entry.error.value).toBe("Unauthorized");
    expect(onError).toHaveBeenCalled();
  });

  it("ignores malformed cache entries", async () => {
    const service = createDiscoveryService({
      fetcher: async () => ({ groups: {} }),
      storage: memoryStorage([{ context: 1 } as any]),
    });
    await service.hydrated;
    expect(service.peek("1", "")).toBeNull();
  });
});

describe("discovery helpers", () => {
  const snapshot: DiscoverySnapshot = {
    context: "prod",
    kubeConfig: "/k",
    fetchedAt: 0,
    groups: {
      v1: [pods, { ...pods, name: "pods/log" }],
      apps: [deployments],
      "example.com": [crd],
    },
  };

  it("derives group and version from the group version", () => {
    expect(pods).toMatchObject({ group: "", version: "v1" });
    expect(deployments).toMatchObject({ group: "apps", version: "v1" });
  });

  it("flattens without subresources", () => {
    expect(flattenResources(snapshot).map((r) => r.name)).toEqual([
      "pods",
      "deployments",
      "deployments",
    ]);
  });

  it("finds resources by short name, kind or plural, preferring built-ins", () => {
    expect(findResource(snapshot, "po")?.name).toBe("pods");
    expect(findResource(snapshot, "deploy")?.group).toBe("apps");
    expect(findResource(snapshot, "Deployment")?.group).toBe("apps");
    expect(findResource(snapshot, "nope")).toBeUndefined();
  });

  it("limits concurrency", async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (i === 3) throw new Error("boom");
      return i;
    });

    const results = await runLimited(tasks, 3);

    expect(peak).toBe(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((results[9] as PromiseFulfilledResult<number>).value).toBe(9);
  });
});
