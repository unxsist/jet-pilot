import { describe, expect, test, vi } from "vitest";
import {
  cachedPrinterColumns,
  crdPrinterColumns,
  loadPrinterColumns,
  resolveListResource,
} from "@/lib/crds";
import {
  evaluateJsonPath,
  formatRelativeDate,
  isStateColumn,
  printerColumnDefs,
} from "@/components/tables/printerColumns";
import type { DiscoveredResource } from "@/lib/discovery";

const backupCrd = {
  spec: {
    group: "velero.io",
    versions: [
      {
        name: "v1beta1",
        served: true,
        storage: false,
        additionalPrinterColumns: [{ name: "Old", type: "string", jsonPath: ".spec.old" }],
      },
      {
        name: "v1",
        served: true,
        storage: true,
        additionalPrinterColumns: [
          { name: "Status", type: "string", jsonPath: ".status.phase", description: "Backup status" },
          { name: "Expires", type: "date", jsonPath: ".status.expiration" },
          { name: "Location", type: "string", jsonPath: ".spec.storageLocation", priority: 1 },
          { name: "Broken", type: "string" },
          { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
        ],
      },
    ],
  },
};

describe("CRD printer columns", () => {
  test("the served version's columns", () => {
    expect(crdPrinterColumns(backupCrd, "v1")).toEqual([
      { name: "Status", type: "string", jsonPath: ".status.phase", description: "Backup status" },
      { name: "Expires", type: "date", jsonPath: ".status.expiration" },
      { name: "Location", type: "string", jsonPath: ".spec.storageLocation", priority: 1 },
      { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
    ]);
    expect(crdPrinterColumns(backupCrd, "v1beta1").map((c) => c.name)).toEqual(["Old"]);
  });

  test("an unknown version falls back to the storage version", () => {
    expect(crdPrinterColumns(backupCrd, "v2")[0].name).toBe("Status");
  });

  test("apiextensions v1beta1: one list with JSONPath", () => {
    const crd = {
      spec: {
        versions: [{ name: "v1alpha1", served: true, storage: true }],
        additionalPrinterColumns: [{ name: "Ready", type: "string", JSONPath: ".status.ready" }],
      },
    };
    expect(crdPrinterColumns(crd, "v1alpha1")).toEqual([
      { name: "Ready", type: "string", jsonPath: ".status.ready" },
    ]);
  });

  test("nothing to show", () => {
    expect(crdPrinterColumns(null, "v1")).toEqual([]);
    expect(crdPrinterColumns({ spec: { versions: [{ name: "v1" }] } }, "v1")).toEqual([]);
  });

  test("column definitions: dates relative, priority hidden, descriptions as tooltips", () => {
    const defs = printerColumnDefs(crdPrinterColumns(backupCrd, "v1"), ["Name", "Age"]) as any[];
    expect(defs.map((d) => d.header)).toEqual(["Status", "Expires", "Location"]);
    expect(defs[0].meta.headerTitle).toBe("Backup status");
    expect(defs[2].meta.defaultHidden).toBe(true);
    const row = { status: { phase: "Completed", expiration: "2030-01-01T00:00:00Z" } };
    expect(defs[0].accessorFn(row)).toBe("Completed");
    expect(defs[1].accessorFn(row)).toBe(Date.parse("2030-01-01T00:00:00Z"));
    // State columns get a dot.
    expect(typeof defs[0].cell).toBe("function");
    expect(defs[2].cell).toBeUndefined();
  });

  test("state columns", () => {
    expect(isStateColumn({ name: "Ready", type: "string" })).toBe(true);
    expect(isStateColumn({ name: "Phase" })).toBe(true);
    expect(isStateColumn({ name: "Ready", type: "integer" })).toBe(false);
    expect(isStateColumn({ name: "Secret", type: "string" })).toBe(false);
  });

  test("dates in the future read 'in …'", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    expect(formatRelativeDate("2026-10-18T12:00:00Z", now)).toBe("in 3d");
    expect(formatRelativeDate("2026-10-14T12:00:00Z", now)).toBe("1d");
    expect(formatRelativeDate(undefined, now)).toBe("-");
  });
});

describe("JSONPath filters", () => {
  const object = {
    status: {
      conditions: [
        { type: "Ready", status: "True", observedGeneration: 3 },
        { type: "Issuing", status: "False", reason: "Failed" },
      ],
    },
    metadata: { labels: { "node.kubernetes.io/instance-type": "m6i.large" } },
  };

  test("select by field, like kubectl", () => {
    expect(evaluateJsonPath(object, '.status.conditions[?(@.type=="Ready")].status')).toBe("True");
    expect(evaluateJsonPath(object, ".status.conditions[?(@.type=='Issuing')].reason")).toBe("Failed");
    expect(evaluateJsonPath(object, '.status.conditions[?(@.type == "Ready")].status')).toBe("True");
    expect(evaluateJsonPath(object, '.status.conditions[?(@.type!="Ready")].type')).toBe("Issuing");
    expect(evaluateJsonPath(object, ".status.conditions[?(@.observedGeneration==3)].type")).toBe("Ready");
    expect(evaluateJsonPath(object, ".status.conditions[?(@.reason)].type")).toBe("Issuing");
    expect(evaluateJsonPath(object, '.status.conditions[?(@.type=="Nope")].status')).toBeUndefined();
  });

  test("broken filters evaluate to nothing", () => {
    expect(evaluateJsonPath(object, ".status.conditions[?(@.type=Ready)].status")).toBeUndefined();
    expect(evaluateJsonPath(object, ".status.conditions[?(@.type==\"Ready\"].status")).toBeUndefined();
  });
});

describe("resolving a list's resource", () => {
  const r = (group: string, name: string, kind: string): DiscoveredResource => ({
    name,
    kind,
    group,
    version: "v1",
    namespaced: true,
    verbs: [],
  });
  const resources = [
    r("networking.istio.io", "gateways", "Gateway"),
    r("gateway.networking.k8s.io", "gateways", "Gateway"),
    r("velero.io", "backups", "Backup"),
    r("metrics.k8s.io", "pods", "PodMetrics"),
    r("", "pods", "Pod"),
  ];

  test("built-in groups win, like the backend", () => {
    expect(resolveListResource(resources, "gateways", "Gateway")?.group).toBe("gateway.networking.k8s.io");
    expect(resolveListResource(resources, "pods", "Pod")?.group).toBe("");
  });

  test("plural.group picks the group", () => {
    expect(resolveListResource(resources, "gateways.networking.istio.io", "Gateway")?.group).toBe(
      "networking.istio.io"
    );
  });

  test("kind fallback", () => {
    expect(resolveListResource(resources, "podmetrics.metrics.k8s.io", "PodMetrics")?.name).toBe("pods");
    expect(resolveListResource(resources, "nothing")).toBeUndefined();
  });
});

describe("the CRD cache", () => {
  const backups: DiscoveredResource = {
    name: "backups",
    kind: "Backup",
    group: "velero.io",
    version: "v1",
    namespaced: true,
    verbs: [],
  };
  const target = { context: "prod", kubeConfig: "/kube" };

  test("one fetch per discovery; revalidated when discovery changes", async () => {
    const get = vi.fn(async (_target: unknown, path: string) => {
      expect(path).toBe("/apis/apiextensions.k8s.io/v1/customresourcedefinitions/backups.velero.io");
      return backupCrd;
    });
    expect(cachedPrinterColumns(target, backups)).toBeUndefined();
    const first = await loadPrinterColumns(target, backups, 100, get as any);
    expect(first.map((c) => c.name)).toContain("Status");
    await loadPrinterColumns(target, backups, 100, get as any);
    expect(get).toHaveBeenCalledTimes(1);
    expect(cachedPrinterColumns(target, backups)).toEqual(first);
    await loadPrinterColumns(target, backups, 200, get as any);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("a failed request has no columns (and keeps what it had)", async () => {
    const other = { ...target, context: "staging" };
    const failing = vi.fn(async () => {
      throw new Error("forbidden");
    });
    expect(await loadPrinterColumns(other, backups, 1, failing as any)).toEqual([]);
    const ok = vi.fn(async () => backupCrd);
    const loaded = await loadPrinterColumns(other, backups, 2, ok as any);
    expect(await loadPrinterColumns(other, backups, 3, failing as any)).toEqual(loaded);
  });
});
