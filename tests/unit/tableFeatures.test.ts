import { beforeEach, describe, expect, test } from "vitest";
import {
  loadTablePrefs,
  moveColumn,
  prefsKey,
  resolveColumnOrder,
  saveTablePrefs,
} from "@/components/tables/columnPrefs";
import {
  availableGroupOptions,
  buildDisplayItems,
  groupOption,
} from "@/components/tables/grouping";
import {
  collectPrinterColumns,
  evaluateJsonPath,
  printerColumnDefs,
  printerValue,
} from "@/components/tables/printerColumns";
import {
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
  podResources,
  podUsageSamples,
  sparklinePath,
  summarize,
  usageTone,
} from "@/components/tables/metrics";
import { createRowReconciler, rowVersion } from "@/components/tables/rowModel";
import { getRowIdentity } from "@/components/tables/identity";
import { isReactive, reactive } from "vue";

/* Minimal localStorage for the node test environment. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe("column prefs", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemoryStorage();
  });

  test("round trip under jet.table.<kind>", () => {
    saveTablePrefs("pods", {
      order: ["Name", "Status"],
      sizes: { Name: 240 },
      visibility: { IP: false },
      groupBy: "namespace",
    });
    expect(localStorage.getItem("jet.table.pods")).toBeTruthy();
    expect(loadTablePrefs("pods")).toEqual({
      order: ["Name", "Status"],
      sizes: { Name: 240 },
      visibility: { IP: false },
      groupBy: "namespace",
    });
    expect(prefsKey("Log Lines")).toBe("jet.table.log-lines");
  });

  test("empty prefs remove the key; garbage is ignored", () => {
    saveTablePrefs("pods", { order: ["a"] });
    saveTablePrefs("pods", {});
    expect(localStorage.getItem("jet.table.pods")).toBeNull();

    localStorage.setItem("jet.table.x", "{not json");
    expect(loadTablePrefs("x")).toEqual({});
    localStorage.setItem(
      "jet.table.y",
      JSON.stringify({
        order: [1, "a"],
        sizes: { a: -1, b: 90, c: "x" },
        visibility: { a: "no", b: true },
      })
    );
    expect(loadTablePrefs("y")).toEqual({
      order: ["a"],
      sizes: { b: 90 },
      visibility: { b: true },
    });
  });

  test("column order keeps select first / actions last and slots in new columns", () => {
    const ids = [
      "select",
      "context",
      "namespace",
      "Name",
      "Status",
      "CPU",
      "Age",
      "actions",
    ];
    expect(resolveColumnOrder(ids, undefined)).toEqual(ids);
    expect(resolveColumnOrder(ids, ["Status", "Name", "Age"])).toEqual([
      "select",
      "context",
      "namespace",
      "Status",
      // unknown to the stored order: right after its predecessor (Status)
      "CPU",
      "Name",
      "Age",
      "actions",
    ]);
    // stale ids from older versions are dropped
    expect(
      resolveColumnOrder(["select", "Name", "Age"], ["Gone", "Age", "Name"])
    ).toEqual(["select", "Age", "Name"]);
  });

  test("moveColumn", () => {
    const order = ["select", "Name", "Status", "Age", "actions"];
    expect(moveColumn(order, "Status", "Name")).toEqual([
      "select",
      "Status",
      "Name",
      "Age",
      "actions",
    ]);
    expect(moveColumn(order, "Name", null)).toEqual([
      "select",
      "Status",
      "Age",
      "Name",
      "actions",
    ]);
    expect(moveColumn(order, "Age", "select")).toEqual([
      "select",
      "Age",
      "Name",
      "Status",
      "actions",
    ]);
    expect(moveColumn(order, "select", "Age")).toEqual(order);
  });
});

describe("grouping", () => {
  const pods = [
    {
      metadata: {
        name: "a",
        namespace: "web",
        context: "prod",
        ownerReferences: [
          { kind: "ReplicaSet", name: "a-rs", controller: true },
        ],
      },
      spec: { nodeName: "n1" },
    },
    {
      metadata: { name: "b", namespace: "db", context: "prod" },
      spec: { nodeName: "n2" },
    },
    {
      metadata: { name: "c", namespace: "web", context: "dev" },
      spec: { nodeName: "n1" },
    },
    { metadata: { name: "d", context: "dev" } },
  ];
  const rows = pods.map((original, i) => ({ id: String(i), original }));

  test("groups in sorted order with counts, (none) last", () => {
    const items = buildDisplayItems(rows, groupOption("namespace"), new Set());
    expect(
      items.map((i) => (i.type === "group" ? `[${i.label} ${i.count}]` : i.id))
    ).toEqual(["[db 1]", "1", "[web 2]", "0", "2", "[(none) 1]", "3"]);
  });

  test("collapsed groups hide their rows", () => {
    const items = buildDisplayItems(
      rows,
      groupOption("namespace"),
      new Set(["web"])
    );
    expect(items.map((i) => i.id)).toEqual([
      "group:db",
      "1",
      "group:web",
      "group:",
      "3",
    ]);
    expect(items.find((i) => i.id === "group:web")).toMatchObject({
      collapsed: true,
      count: 2,
    });
  });

  test("owner / node groups and available options", () => {
    const owner = buildDisplayItems(rows, groupOption("owner"), new Set());
    expect(owner[0]).toMatchObject({ type: "group", label: "ReplicaSet/a-rs" });
    expect(availableGroupOptions(pods).map((o) => o.id)).toEqual([
      "namespace",
      "context",
      "node",
      "owner",
    ]);
    expect(
      availableGroupOptions([
        { metadata: { name: "node-1", context: "x" } },
      ]).map((o) => o.id)
    ).toEqual(["context"]);
  });

  test("no grouping: one item per row", () => {
    expect(buildDisplayItems(rows, null, new Set()).map((i) => i.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
  });
});

describe("printer columns", () => {
  const row = {
    kind: "Certificate",
    metadata: { name: "web-tls", labels: { "app.kubernetes.io/name": "web" } },
    spec: { replicas: 3, ports: [{ port: 80 }, { port: 443 }] },
    status: { conditions: [{ type: "Ready", status: "True" }] },
    __printerColumns: [
      { name: "Ready", value: "True" },
      { name: "Replicas", jsonPath: ".spec.replicas", type: "integer" },
      { name: "Ports", jsonPath: ".spec.ports[*].port" },
      { name: "Issued", value: "2026-10-01T10:00:00Z", type: "date" },
      { name: "Secret", jsonPath: ".spec.secretName", priority: 1 },
      { name: "Age", jsonPath: ".metadata.creationTimestamp", type: "date" },
    ],
  };

  test("simple JSONPath", () => {
    expect(evaluateJsonPath(row, ".spec.replicas")).toBe(3);
    expect(evaluateJsonPath(row, "{.spec.ports[1].port}")).toBe(443);
    expect(evaluateJsonPath(row, "$.spec.ports[*].port")).toEqual([80, 443]);
    expect(
      evaluateJsonPath(row, ".metadata.labels['app.kubernetes.io/name']")
    ).toBe("web");
    expect(evaluateJsonPath(row, ".status.conditions[-1].type")).toBe("Ready");
    expect(evaluateJsonPath(row, ".nope.deeper")).toBeUndefined();
    expect(
      evaluateJsonPath(row, ".status.conditions[?(@.type=='Ready')]")
    ).toBeUndefined();
  });

  test("values: explicit value wins, arrays are joined", () => {
    expect(printerValue(row, { name: "Ready" })).toBe("True");
    expect(printerValue(row, { name: "Ports" })).toBe("80, 443");
  });

  test("column definitions skip existing headers and hide priority columns", () => {
    const defs = printerColumnDefs(collectPrinterColumns([row]), [
      "Name",
      "Age",
    ]);
    expect(defs.map((d) => d.header)).toEqual([
      "Ready",
      "Replicas",
      "Ports",
      "Issued",
      "Secret",
    ]);
    const replicas = defs[1] as any;
    expect(replicas.meta.numeric).toBe(true);
    expect(replicas.accessorFn(row)).toBe(3);
    expect((defs[4] as any).meta.defaultHidden).toBe(true);
    const issued = defs[3] as any;
    expect(issued.accessorFn(row)).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });
});

describe("metrics", () => {
  test("quantities", () => {
    expect(parseCpu("250m")).toBe(250);
    expect(parseCpu("2")).toBe(2000);
    expect(parseCpu("1500000n")).toBeCloseTo(1.5);
    expect(parseCpu("12u")).toBeCloseTo(0.012);
    expect(parseCpu(undefined)).toBe(0);
    expect(parseMemory("128Mi")).toBe(128 * 1024 ** 2);
    expect(parseMemory("1G")).toBe(1e9);
    expect(parseMemory("2048")).toBe(2048);
    expect(parseMemory("1e3")).toBe(1000);
    expect(parseMemory("garbage")).toBe(0);
    expect(formatCpu(1234.4)).toBe("1234m");
    expect(formatCpu(0.4)).toBe("<1m");
    expect(formatMemory(128 * 1024 ** 2)).toBe("128Mi");
    expect(formatMemory(1.5 * 1024 ** 3)).toBe("1.5Gi");
  });

  const pod = {
    spec: {
      containers: [
        {
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
        },
        { resources: { requests: { cpu: "50m" } } },
      ],
    },
    metrics: [
      {
        timestamp: "2026-10-04T10:00:00Z",
        containers: [
          { usage: { cpu: "120000000n", memory: "100Mi" } },
          { usage: { cpu: "5m", memory: "20Mi" } },
        ],
      },
    ],
  };

  test("requests / limits: limits only when every container has one", () => {
    expect(podResources(pod)).toEqual({
      cpu: { request: 150, limit: 0 },
      memory: { request: 128 * 1024 ** 2, limit: 0 },
    });
    const bounded = { spec: { containers: [pod.spec.containers[0]] } };
    expect(podResources(bounded).cpu).toEqual({ request: 100, limit: 500 });
  });

  test("samples come from metricsHistory, else from the current PodMetric", () => {
    expect(podUsageSamples(pod)).toEqual([
      {
        ts: Date.parse("2026-10-04T10:00:00Z"),
        cpu: 125,
        memory: 120 * 1024 ** 2,
      },
    ]);
    const withHistory = {
      ...pod,
      metricsHistory: [
        { ts: 1, cpu: 10, memory: 5 },
        { ts: 2, cpu: 20, memory: 6 },
      ],
    };
    expect(podUsageSamples(withHistory).map((s) => s.cpu)).toEqual([10, 20]);
  });

  test("summary, tone and sparkline path", () => {
    expect(summarize([1, 3, 2])).toEqual({ latest: 2, min: 1, max: 3, avg: 2 });
    expect(summarize([])).toBeNull();
    expect(usageTone(460, { request: 100, limit: 500 })).toBe("destructive");
    expect(usageTone(400, { request: 100, limit: 500 })).toBe("warning");
    expect(usageTone(400, { request: 100, limit: 0 })).toBe("normal");
    expect(sparklinePath([0, 10], 40, 12, 10)).toBe("M0.00 11.00 L40.00 1.00");
    expect(sparklinePath([5], 40, 12, 10)).toBe("M0 6.00 L40 6.00");
    expect(sparklinePath([], 40, 12, 10)).toBe("");
  });
});

describe("row reconciliation", () => {
  const pod = (uid: string, rv: string, extra: object = {}) => ({
    metadata: { uid, resourceVersion: rv, context: "prod", name: uid },
    ...extra,
  });

  test("version includes metrics so metric-only changes re-render", () => {
    expect(rowVersion(pod("a", "1"))).toBe("1");
    expect(
      rowVersion(pod("a", "1", { metrics: [{ timestamp: "t1" }] }))
    ).not.toBe(rowVersion(pod("a", "1", { metrics: [{ timestamp: "t2" }] })));
    expect(rowVersion(pod("a", "1", { metricsHistory: [{ ts: 1 }] }))).not.toBe(
      rowVersion(pod("a", "1", { metricsHistory: [{ ts: 1 }, { ts: 2 }] }))
    );
    expect(rowVersion({ ...pod("a", "1"), __rowVersion: 7 })).toBe("7");
    expect(rowVersion({ name: "helm-release" })).toBeNull();
  });

  test("unchanged rows keep their object; changed / unversioned rows are new; rows are raw", () => {
    const reconcile = createRowReconciler(getRowIdentity);
    const first = reconcile([
      pod("a", "1"),
      pod("b", "1"),
      { name: "x", metadata: { context: "prod" } },
    ]);
    const second = reconcile([
      pod("a", "1"),
      pod("b", "2"),
      { name: "x", metadata: { context: "prod" } },
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(isReactive(reactive({ row: second[0] }).row)).toBe(false);
  });
});
