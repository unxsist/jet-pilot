import { beforeEach, describe, expect, test, vi } from "vitest";

/* The cluster: which services exist and which of them answer `count(up)`. */
const cluster = {
  listForbidden: false,
  services: [] as { name: string; namespace: string; port: string }[],
  answering: new Set<string>(),
  lists: 0,
};

vi.mock("@/lib/kubeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kubeApi")>();
  return {
    ...actual,
    kubeGet: vi.fn(async (_target: unknown, path: string) => {
      if (path !== "/api/v1/services") throw new Error(`unexpected ${path}`);
      cluster.lists++;
      if (cluster.listForbidden) throw { code: 403, message: "services is forbidden" };
      return {
        items: cluster.services.map((s) => ({
          metadata: { name: s.name, namespace: s.namespace },
          spec: { ports: [{ name: s.port, port: 9090 }] },
        })),
      };
    }),
    kubeServiceProxy: vi.fn(async (_target: unknown, ref: { service: string }) => {
      if (!cluster.answering.has(ref.service)) throw { code: 503, message: `no endpoints available for service "${ref.service}"` };
      return { status: "success", data: { resultType: "vector", result: [] } };
    }),
  };
});

import { discover, discoverCached, forgetDiscovery } from "@/lib/metrics/discovery";

const target = { context: "prod", kubeConfig: "/k" };

beforeEach(() => {
  cluster.listForbidden = false;
  cluster.services = [
    { name: "kube-prometheus-stack-prometheus", namespace: "monitoring", port: "http-web" },
    { name: "prometheus-operated", namespace: "monitoring", port: "web" },
  ];
  cluster.answering = new Set(["kube-prometheus-stack-prometheus", "prometheus-operated"]);
  cluster.lists = 0;
  forgetDiscovery(target);
});

describe("discovery", () => {
  test("uses the best candidate that answers", async () => {
    cluster.answering.delete("kube-prometheus-stack-prometheus");
    const result = await discover(target);
    expect(result.found?.source.service).toBe("prometheus-operated");
    expect(result.candidates.map((c) => [c.source.service, c.ok])).toEqual([
      ["kube-prometheus-stack-prometheus", false],
      ["prometheus-operated", true],
    ]);
    expect(result.candidates[0]!.error).toBe("No running pods behind kube-prometheus-stack-prometheus in monitoring");
  });

  test("nothing answering: none found", async () => {
    cluster.answering.clear();
    expect((await discover(target)).found).toBeNull();
  });

  test("without permission to list services, tries the usual names", async () => {
    cluster.listForbidden = true;
    cluster.answering = new Set(["prometheus-k8s"]);
    const result = await discover(target);
    expect(result.limited).toBe(true);
    expect(result.found?.source).toEqual({ namespace: "monitoring", service: "prometheus-k8s", port: "web" });
    expect(result.candidates).toHaveLength(1);
  });

  test("cached per cluster until forgotten", async () => {
    await discoverCached(target);
    await discoverCached(target);
    expect(cluster.lists).toBe(1);
    await discoverCached({ context: "staging", kubeConfig: "/k" });
    expect(cluster.lists).toBe(2);
    forgetDiscovery(target);
    await discoverCached(target);
    expect(cluster.lists).toBe(3);
  });
});
