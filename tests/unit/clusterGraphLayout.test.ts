import { describe, expect, test } from "vitest";
import {
  AppGroup,
  GraphObject,
  buildTopology,
  visibleGraph,
} from "@/lib/clusterGraph";
import {
  CARD_WIDTH,
  GraphLayoutCache,
  flowOrder,
  layoutGroup,
  nodeSize,
} from "@/lib/clusterGraphLayout";
import {
  healthStrip,
  nodeSubtitle,
} from "@/components/vue-flow/nodeStatus";

let counter = 0;
const object = (kind: string, name: string, extra: any = {}, namespace = "shop"): GraphObject => {
  const { metadata, ...rest } = extra;
  return {
    kind,
    metadata: { name, namespace, uid: `${name}-${++counter}`, ...(metadata || {}) },
    ...rest,
  };
};

const app = (name: string, namespace = "shop") => {
  const labels = { app: name };
  const dep = object(
    "Deployment",
    name,
    {
      spec: { replicas: 1, template: { metadata: { labels }, spec: { containers: [{ envFrom: [{ configMapRef: { name: `${name}-cfg` } }] }] } } },
      status: { availableReplicas: 1 },
    },
    namespace
  );
  return [
    dep,
    object("Service", name, { spec: { selector: labels } }, namespace),
    object("Ingress", name, { spec: { rules: [{ host: `${name}.dev`, http: { paths: [{ backend: { service: { name } } }] } }] } }, namespace),
    object("ConfigMap", `${name}-cfg`, { data: { a: "1", b: "2" } }, namespace),
  ];
};

const none = { expanded: new Set<string>(), history: new Set<string>() };

describe("layoutGroup", () => {
  test("flows left to right: Ingress -> Service -> Deployment -> ConfigMap", () => {
    const topology = buildTopology(app("web"));
    const graph = visibleGraph(topology, none);
    const { positions } = layoutGroup(graph.nodes, graph.edges);
    const x = (kind: string) =>
      positions.get(graph.nodes.find((node) => node.kind === kind)!.id)!.x;
    expect(x("Ingress")).toBeLessThan(x("Service"));
    expect(x("Service")).toBeLessThan(x("Deployment"));
    expect(x("Deployment")).toBeLessThan(x("ConfigMap"));
  });

  test("nodes do not overlap", () => {
    const objects = [...app("web"), object("ConfigMap", "loose-a"), object("ConfigMap", "loose-b")];
    const topology = buildTopology(objects);
    const graph = visibleGraph(topology, none, { showUnused: true });
    const nodes = graph.nodes.filter((node) => node.group === "shop/web");
    const { positions } = layoutGroup(nodes, graph.edges.filter((e) => nodes.some((n) => n.id === e.source)));
    const boxes = nodes.map((node) => ({ ...positions.get(node.id)!, ...nodeSize(node) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe("GraphLayoutCache", () => {
  test("lays out each group once and reuses unchanged groups", () => {
    const objects = [...app("a"), ...app("b"), ...app("c", "other")];
    const cache = new GraphLayoutCache();
    const first = cache.layout(visibleGraph(buildTopology(objects), none));
    expect(first.computed).toBe(3);
    expect(first.lanes.map((lane) => lane.namespace)).toEqual(["other", "shop"]);

    // A refresh with the same structure (new object instances).
    const again = cache.layout(visibleGraph(buildTopology(objects.map((o) => ({ ...o }))), none));
    expect(again.computed).toBe(0);
    expect([...again.nodes.values()]).toEqual([...first.nodes.values()]);

    // Expanding one workload only re-lays out its group.
    const topology = buildTopology([
      ...objects,
      object("Pod", "a-1", { metadata: { labels: { app: "a" }, ownerReferences: [{ uid: objects[0].metadata.uid, kind: "Deployment", name: "a", controller: true }] }, status: { phase: "Running" } }),
    ]);
    const expanded = cache.layout(
      visibleGraph(topology, { expanded: new Set([objects[0].metadata.uid!]), history: new Set() })
    );
    expect(expanded.computed).toBe(1);
  });

  test("groups never overlap", () => {
    const objects = Array.from({ length: 12 }, (_, i) => app(`app-${i}`, `ns-${i % 3}`)).flat();
    const layout = new GraphLayoutCache().layout(visibleGraph(buildTopology(objects), none));
    const rects = [...layout.groups.values()];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
    }
    expect(Math.max(...rects.map((r) => r.width))).toBeGreaterThan(CARD_WIDTH);
  });
});

describe("flowOrder", () => {
  const group = (id: string, type: AppGroup["type"] = "app"): AppGroup => ({
    id,
    name: id,
    namespace: "x",
    type,
    nodeIds: [],
    health: "ok",
  });

  test("puts entry points right before the apps they route to", () => {
    const groups = [group("x/alpha"), group("x/beta"), group("x/zeta-ingress"), group("x/~shared", "shared"), group("x/gamma")];
    const cross = new Map([["x/zeta-ingress", new Set(["x/gamma", "x/beta"])]]);
    expect(flowOrder(groups, cross).map((g) => g.id)).toEqual([
      "x/zeta-ingress",
      "x/beta",
      "x/gamma",
      "x/alpha",
      "x/~shared",
    ]);
  });
});

describe("card presentation", () => {
  test("subtitles summarise each kind", () => {
    const topology = buildTopology([
      ...app("web"),
      object("PersistentVolumeClaim", "data", { spec: { storageClassName: "gp3" }, status: { phase: "Bound", capacity: { storage: "10Gi" } } }),
      object("HorizontalPodAutoscaler", "web", { spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 8 }, status: { currentReplicas: 3 } }),
    ]);
    const byKind = (kind: string) => [...topology.nodes.values()].find((node) => node.kind === kind)!;
    expect(nodeSubtitle(byKind("Deployment"))).toBe("Deployment · 1/1 ready");
    expect(nodeSubtitle(byKind("Ingress"))).toBe("web.dev");
    expect(nodeSubtitle(byKind("ConfigMap"))).toBe("ConfigMap · 2 keys");
    expect(nodeSubtitle(byKind("PersistentVolumeClaim"))).toBe("10Gi · Bound · gp3");
    expect(nodeSubtitle(byKind("HorizontalPodAutoscaler"))).toBe("HPA · 2–8 · now 3");
  });

  test("the health strip has one segment per pod, by name", () => {
    const dep = object("Deployment", "w", { spec: { replicas: 2, template: { spec: {} } }, status: { availableReplicas: 1 } });
    const owner = [{ uid: dep.metadata.uid, kind: "Deployment", name: "w", controller: true }];
    const ok = object("Pod", "w-b", { metadata: { ownerReferences: owner }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } });
    const bad = object("Pod", "w-a", { metadata: { ownerReferences: owner }, status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } }] } });
    const topology = buildTopology([dep, ok, bad]);
    const strip = healthStrip(topology.nodes.get(dep.metadata.uid!)!);
    expect(strip.map((s) => [s.name, s.tone])).toEqual([
      ["w-a", "destructive"],
      ["w-b", "success"],
    ]);
  });
});
