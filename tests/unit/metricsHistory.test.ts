import { describe, expect, test } from "vitest";
import { rankCandidates, type ServiceLike } from "@/lib/metrics/discovery";
import {
  containerSelector,
  cpuQuery,
  escapeRegex,
  matchesPods,
  memoryQuery,
  networkQuery,
  nodeCpuQuery,
  nodeMemoryQuery,
  podPattern,
  quote,
  resourcesQuery,
} from "@/lib/metrics/promql";
import { toPrometheusError } from "@/lib/metrics/prometheus";
import { alignValues, bucketSamples, sumValues, summarizeValues, valueAt } from "@/lib/metrics/series";
import { queryWindow, rateWindow, stepFor, timeTicks, windowTimes } from "@/lib/metrics/time";
import { formatBytes, formatCores, formatCoresTick, formatRate, niceScale, percentOf } from "@/lib/metrics/units";
import { fallbackUsage, scopeOf, specReferences, statusRestartMarkers } from "@/lib/metrics/usage";
import { areaPath, monotonePath, segments } from "@/components/charts/path";

const svc = (namespace: string, name: string, ports: { name?: string; port: number }[], extra: Partial<ServiceLike["spec"]> & { labels?: Record<string, string> } = {}): ServiceLike => ({
  metadata: { name, namespace, labels: extra.labels },
  spec: { ports, clusterIP: extra.clusterIP ?? "10.0.0.1" },
});

describe("discovery ranking", () => {
  const services = [
    svc("monitoring", "kube-prometheus-stack-prometheus", [{ name: "http-web", port: 9090 }, { name: "reloader-web", port: 8080 }]),
    svc("monitoring", "prometheus-operated", [{ name: "web", port: 9090 }], { clusterIP: "None" }),
    svc("monitoring", "kube-prometheus-stack-alertmanager", [{ name: "http-web", port: 9093 }]),
    svc("monitoring", "kube-prometheus-stack-prometheus-node-exporter", [{ name: "http-metrics", port: 9100 }]),
    svc("monitoring", "kube-prometheus-stack-kube-state-metrics", [{ name: "http", port: 8080 }]),
    svc("monitoring", "kube-prometheus-stack-operator", [{ name: "https", port: 443 }]),
    svc("kube-system", "kube-prometheus-stack-kubelet", [{ name: "https-metrics", port: 10250 }]),
    svc("default", "frontend", [{ name: "http", port: 80 }]),
  ];

  test("finds the stack's Prometheus before the operator's headless service", () => {
    const ranked = rankCandidates(services);
    expect(ranked.map((c) => c.source.service)).toEqual(["kube-prometheus-stack-prometheus", "prometheus-operated"]);
    expect(ranked[0]!.source).toEqual({ namespace: "monitoring", service: "kube-prometheus-stack-prometheus", port: "http-web" });
  });

  test("prefers a query layer and knows vmselect's path", () => {
    const ranked = rankCandidates([
      ...services,
      svc("observability", "thanos-query", [{ name: "grpc", port: 10901 }, { name: "http", port: 9090 }]),
      svc("vm", "vmselect-main", [{ name: "http", port: 8481 }]),
      svc("vm", "vminsert-main", [{ name: "http", port: 8480 }]),
    ]);
    expect(ranked[0]!.kind).toBe("thanos");
    expect(ranked[0]!.source.port).toBe("http");
    const vm = ranked.find((c) => c.kind === "victoriametrics")!;
    expect(vm.source).toEqual({ namespace: "vm", service: "vmselect-main", port: "http", pathPrefix: "/select/0/prometheus" });
    expect(ranked.some((c) => c.source.service === "vminsert-main")).toBe(false);
  });

  test("the community chart and kube-prometheus by name", () => {
    const ranked = rankCandidates([
      svc("prometheus", "prometheus-server", [{ name: "http", port: 80 }]),
      svc("monitoring", "prometheus-k8s", [{ name: "web", port: 9090 }, { name: "reloader-web", port: 8080 }]),
    ]);
    expect(ranked.map((c) => [c.source.service, c.source.port])).toEqual([
      ["prometheus-k8s", "web"],
      ["prometheus-server", "http"],
    ]);
  });

  test("skips services without a usable port", () => {
    expect(rankCandidates([svc("monitoring", "prometheus", [{ name: "grpc", port: 10901 }, { name: "metrics", port: 8080 }])])).toEqual([]);
  });
});

describe("time math", () => {
  test("steps fit the width and stay on round numbers", () => {
    expect(stepFor(3600, 330)).toBe(60);
    expect(stepFor(3600, 600)).toBe(30);
    expect(stepFor(6 * 3600, 330)).toBe(300);
    expect(stepFor(86400, 330)).toBe(900);
    expect(stepFor(7 * 86400, 330)).toBe(7200);
    // Never finer than a scrape.
    expect(stepFor(600, 2000)).toBe(15);
  });

  test("rate windows cover a few scrapes and the whole step", () => {
    expect(rateWindow(30)).toBe("120s");
    expect(rateWindow(900)).toBe("900s");
  });

  test("windows end now (on 15 s) and span whole steps", () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 7);
    const w = queryWindow(now, 3600, 60);
    expect(w.end).toBe(Date.UTC(2026, 9, 14, 12, 0, 0) / 1000);
    expect(w.end - w.start).toBe(3600);
    expect(w.count).toBe(61);
    const times = windowTimes(w);
    expect(times[0]).toBe(w.start * 1000);
    expect(times[times.length - 1]).toBe(w.end * 1000);
  });

  test("time labels land on round times", () => {
    const from = new Date(2026, 9, 14, 9, 7).getTime();
    const ticks = timeTicks(from, from + 6 * 3600_000, 4);
    expect(ticks.length).toBeLessThanOrEqual(4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) expect(new Date(t).getMinutes()).toBe(0);
  });
});

describe("PromQL", () => {
  test("pod name patterns per kind", () => {
    expect(podPattern("Pod", "api-7d9f-abcde")).toBe("api-7d9f-abcde");
    expect(matchesPods(podPattern("Deployment", "api")!, "api-7c5b9d4f6-x2k9z")).toBe(true);
    // Another deployment's pods: its name has vowels, not a hash.
    expect(matchesPods(podPattern("Deployment", "api")!, "api-gateway-7c5b9d4f6-x2k9z")).toBe(false);
    expect(matchesPods(podPattern("StatefulSet", "db")!, "db-0")).toBe(true);
    expect(matchesPods(podPattern("StatefulSet", "db")!, "db-backup-28745160-x2k9z")).toBe(false);
    expect(matchesPods(podPattern("DaemonSet", "node-agent")!, "node-agent-x2k9z")).toBe(true);
    expect(matchesPods(podPattern("Job", "backup")!, "backup-3-x2k9z")).toBe(true);
    expect(podPattern("Namespace", "payments")).toBeNull();
  });

  test("escapes names and strings", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(quote('a\\.b"c')).toBe('"a\\\\.b\\"c"');
  });

  test("container usage without the pod cgroup and pause containers", () => {
    const scope = { type: "pods" as const, namespace: "payments", pods: "api" };
    expect(containerSelector(scope)).toBe('{namespace="payments",pod=~"api",container!="",container!="POD"}');
    expect(containerSelector(scope, "legacy")).toBe(
      '{namespace="payments",pod_name=~"api",container_name!="",container_name!="POD"}'
    );
    expect(cpuQuery(scope, "120s")).toBe(
      'sum (rate(container_cpu_usage_seconds_total{namespace="payments",pod=~"api",container!="",container!="POD"}[120s]))'
    );
    expect(memoryQuery(scope, true)).toBe(
      'sum by (pod) (container_memory_working_set_bytes{namespace="payments",pod=~"api",container!="",container!="POD"})'
    );
  });

  test("network in and out as one query", () => {
    const query = networkQuery({ type: "pods", namespace: "a", pods: "p" }, "120s");
    expect(query).toContain('label_replace(sum(rate(container_network_receive_bytes_total{namespace="a",pod=~"p"}[120s])), "direction", "in", "", "")');
    expect(query).toContain(" or ");
    expect(query).toContain("container_network_transmit_bytes_total");
  });

  test("requests and limits of running pods", () => {
    const query = resourcesQuery({ type: "pods", namespace: "a", pods: "p" });
    expect(query).toContain('kube_pod_container_resource_requests{namespace="a",pod=~"p",resource=~"cpu|memory"}');
    expect(query).toContain('kube_pod_status_phase{namespace="a",pod=~"p",phase=~"Pending|Running"} == 1');
    expect(query).toContain('"kind", "limit"');
  });

  test("node usage falls back through the usual labels", () => {
    const scope = { type: "node" as const, node: "ip-10-0-1-2", addresses: ["10.0.1.2"] };
    const cpu = nodeCpuQuery(scope, "300s");
    expect(cpu.split(" or ")).toHaveLength(4);
    expect(cpu).toContain('{id="/",node="ip-10-0-1-2"}');
    expect(cpu).toContain('instance=~"(?:ip-10-0-1-2|10\\\\.0\\\\.1\\\\.2)(?::[0-9]+)?"');
    expect(nodeMemoryQuery(scope)).toContain("node_memory_MemAvailable_bytes");
  });
});

describe("units", () => {
  test("cores", () => {
    expect(formatCores(0)).toBe("0");
    expect(formatCores(0.4)).toBe("<1m");
    expect(formatCores(250)).toBe("250m");
    expect(formatCores(1000)).toBe("1 core");
    expect(formatCores(2460)).toBe("2.46 cores");
    expect(formatCoresTick(500)).toBe("500m");
    expect(formatCoresTick(1500)).toBe("1.5");
  });

  test("bytes and rates", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.25 GiB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatRate(1_200_000)).toBe("1.2 MB/s");
    expect(formatRate(340_000)).toBe("340 kB/s");
  });

  test("percent of a reference", () => {
    expect(percentOf(230, 256)).toBe("90%");
    expect(percentOf(1, 1000)).toBe("<1%");
    expect(percentOf(5, 0)).toBeNull();
  });

  test("nice scales", () => {
    expect(niceScale(870, "cpu").ticks).toEqual([0, 500, 1000]);
    expect(niceScale(280 * 1024 ** 2, "bytes")).toMatchObject({ max: 384 * 1024 ** 2, step: 128 * 1024 ** 2 });
    expect(niceScale(0, "cpu").max).toBeGreaterThan(0);
  });
});

describe("series alignment", () => {
  test("samples land on their slot; NaN is a gap", () => {
    const values = alignValues(
      [
        [1000, "1"],
        [1061, "2"],
        [1120, "NaN"],
        [5000, "9"],
      ],
      1000,
      60,
      4,
      1000
    );
    expect(values).toEqual([1000, 2000, null, null]);
  });

  test("sums count missing pods as nothing, not as a gap", () => {
    expect(sumValues([[1, null, 3], [null, null, 4]], 3)).toEqual([1, null, 7]);
  });

  test("summaries and values between gaps", () => {
    expect(summarizeValues([null, 2, 4, null])).toEqual({ latest: 4, min: 2, max: 4, avg: 3 });
    expect(summarizeValues([null])).toBeNull();
    expect(valueAt([1, 2, null], 2)).toBe(2);
  });

  test("metrics-server samples of several pods on one timeline", () => {
    const t = 1_700_000_000_000;
    const timeline = bucketSamples([
      [
        { ts: t, cpu: 100, memory: 10 },
        { ts: t + 15_000, cpu: 110, memory: 11 },
        { ts: t + 30_000, cpu: 120, memory: 12 },
      ],
      // Scraped a few seconds later; one sample lost.
      [
        { ts: t + 3_000, cpu: 50, memory: 5 },
        { ts: t + 33_000, cpu: 70, memory: 7 },
      ],
    ]);
    expect(timeline.times).toHaveLength(3);
    expect(timeline.cpu).toEqual([150, 160, 190]);
    expect(timeline.memory).toEqual([15, 16, 19]);
  });
});

describe("chart paths", () => {
  test("monotone curves stay within their points", () => {
    const d = monotonePath([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    expect(d.startsWith("M0,10C")).toBe(true);
    // A flat stretch stays flat: its control points have y = 10.
    expect(d).toContain("C3.33,10,6.67,10,10,10");
  });

  test("gaps split the line; areas close on the baseline", () => {
    const runs = segments([1, 2, null, 3], (i) => i * 10, (v) => 100 - v);
    expect(runs).toHaveLength(2);
    expect(areaPath(runs, 100)).toBe("M0,99L10,98L10,100L0,100Z");
  });
});

describe("usage model", () => {
  const pod = {
    kind: "Pod",
    metadata: { name: "api-1", namespace: "a" },
    spec: {
      containers: [{ resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } } }],
    },
    status: {
      containerStatuses: [
        { name: "api", lastState: { terminated: { reason: "OOMKilled", finishedAt: new Date(1_700_000_030_000).toISOString() } } },
      ],
    },
  };

  test("references from the spec, times the replicas for workloads", () => {
    expect(specReferences(pod).cpu).toEqual([
      { id: "request", label: "Request", values: 250 },
      { id: "limit", label: "Limit", values: 1000 },
    ]);
    const deployment = { kind: "Deployment", metadata: { name: "api" }, spec: { template: { spec: pod.spec } }, status: { replicas: 3 } };
    expect(specReferences(deployment).memory[0]!.values).toBe(768 * 1024 ** 2);
    const node = { kind: "Node", metadata: { name: "n" }, status: { allocatable: { cpu: "7910m", memory: "32Gi" } } };
    expect(specReferences(node).cpu).toEqual([{ id: "allocatable", label: "Allocatable", values: 7910 }]);
  });

  test("scopes", () => {
    expect(scopeOf({ kind: "Namespace", metadata: { name: "a" } })).toEqual({ type: "pods", namespace: "a" });
    expect(scopeOf({ kind: "Node", metadata: { name: "n" }, status: { addresses: [{ type: "InternalIP", address: "10.0.0.1" }] } })).toEqual({
      type: "node",
      node: "n",
      addresses: ["10.0.0.1"],
    });
  });

  test("an OOM kill from the pod's status becomes a marker", () => {
    const times = [1_700_000_000_000, 1_700_000_015_000, 1_700_000_030_000, 1_700_000_045_000];
    expect(statusRestartMarkers(pod, times)).toEqual([{ index: 2, label: "Out of memory", detail: "api" }]);
  });

  test("metrics-server fallback charts", () => {
    const usage = fallbackUsage(pod, [[{ ts: 1_700_000_000_000, cpu: 100, memory: 1 }]]);
    expect(usage.charts.map((c) => c.id)).toEqual(["cpu", "memory"]);
    expect(usage.charts[0]!.references).toHaveLength(2);
  });
});

describe("errors", () => {
  test("short reasons for common failures", () => {
    const source = { namespace: "monitoring", service: "prometheus-k8s", port: "web" };
    expect(toPrometheusError({ code: 503, message: 'no endpoints available for service "prometheus-k8s"' }, source).summary).toBe(
      "No running pods behind prometheus-k8s in monitoring"
    );
    expect(toPrometheusError({ code: 403, message: "forbidden" }).summary).toBe("Not allowed to use the service proxy");
    const timeout = toPrometheusError({ code: 503, message: JSON.stringify({ status: "error", error: "query timed out" }) });
    expect(timeout.summary).toBe("Prometheus took too long to answer");
    expect(timeout.detail).toBe("query timed out");
    expect(toPrometheusError(new SyntaxError("Unexpected token '<'")).summary).toBe("No Prometheus API at this address");
  });
});
