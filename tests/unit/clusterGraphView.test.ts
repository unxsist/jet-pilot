import { describe, expect, test } from "vitest";
import { effect } from "vue";
import {
  CARD_ZOOM,
  OVERVIEW_ZOOM,
  SpatialIndex,
  literalSearch,
  lodForZoom,
  nearestInDirection,
  searchEntries,
} from "@/lib/clusterGraphView";
import {
  DIM_ALPHA,
  PROBLEMS_DIM_ALPHA,
  SceneCard,
  SceneGroup,
  SceneHighlight,
  cardAlpha,
  groupDimmed,
  viewRect,
} from "@/lib/clusterGraphCanvas";
import { layoutSignature } from "@/lib/clusterGraphLayout";
import {
  GraphObject,
  buildAdjacency,
  buildTopology,
  traceNeighbourhood,
  visibleGraph,
} from "@/lib/clusterGraph";
import {
  FLAG_LIT,
  FLAG_SELECTED,
  HighlightFlags,
} from "@/components/vue-flow/graphState";

const card = (id: string, x: number, y: number, extra: Partial<SceneCard> = {}): SceneCard => ({
  id,
  x,
  y,
  width: 240,
  height: 58,
  name: id,
  subtitle: "",
  health: "ok",
  category: "workload",
  missing: false,
  external: false,
  compact: false,
  group: "shop/web",
  ...extra,
});

const NONE: SceneHighlight = {
  selected: null,
  hovered: null,
  lit: null,
  matches: null,
  problems: false,
  groups: null,
};

describe("level of detail", () => {
  test("switches between cards, canvas cards and the overview", () => {
    expect(lodForZoom(1)).toBe("cards");
    expect(lodForZoom(CARD_ZOOM)).toBe("cards");
    expect(lodForZoom(0.35)).toBe("simple");
    expect(lodForZoom(OVERVIEW_ZOOM - 0.01)).toBe("overview");
  });

  test("is sticky around the thresholds", () => {
    expect(lodForZoom(CARD_ZOOM - 0.02, "cards")).toBe("cards");
    expect(lodForZoom(CARD_ZOOM - 0.02, "simple")).toBe("simple");
    expect(lodForZoom(OVERVIEW_ZOOM + 0.01, "overview")).toBe("overview");
    expect(lodForZoom(OVERVIEW_ZOOM + 0.01, "simple")).toBe("simple");
  });
});

describe("spatial index", () => {
  const cards = [card("a", 0, 0), card("b", 300, 0), card("c", 2000, 1500)];
  const index = new SpatialIndex(cards);

  test("hit-tests points", () => {
    expect(index.at(10, 10)?.id).toBe("a");
    expect(index.at(310, 50)?.id).toBe("b");
    expect(index.at(260, 10)).toBeNull();
    expect(index.at(2100, 1530)?.id).toBe("c");
  });

  test("queries rectangles, each item once", () => {
    const found: string[] = [];
    index.query({ x: -10, y: -10, width: 700, height: 100 }, (item) => found.push(item.id));
    expect(found.sort()).toEqual(["a", "b"]);
    const all: string[] = [];
    index.query({ x: -5000, y: -5000, width: 10000, height: 10000 }, (item) => all.push(item.id));
    expect(all.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("arrow navigation", () => {
  const grid = [
    card("left", 0, 100),
    card("right", 400, 100),
    card("far-right", 800, 100),
    card("below", 0, 300),
    card("diagonal", 400, 500),
  ];

  test("moves to the nearest card in a direction", () => {
    const from = grid[0];
    expect(nearestInDirection(from, grid, "right", from.id)?.id).toBe("right");
    expect(nearestInDirection(from, grid, "down", from.id)?.id).toBe("below");
    expect(nearestInDirection(from, grid, "left", from.id)).toBeNull();
    expect(nearestInDirection(grid[1], grid, "right", "right")?.id).toBe("far-right");
  });

  test("prefers cards on the axis", () => {
    expect(nearestInDirection(grid[3], grid, "right", "below")?.id).toBe("right");
    expect(nearestInDirection(grid[1], grid, "down", "right")?.id).toBe("diagonal");
  });
});

describe("search", () => {
  const nodes = [
    { name: "billing-worker", kind: "Deployment", namespace: "team-b", group: "team-b/billing" },
    { name: "worker-billing", kind: "Deployment", namespace: "team-a", group: "team-a/x" },
    { name: "billing", kind: "Service", namespace: "team-b", group: "team-b/billing" },
    { name: "orders", kind: "ConfigMap", namespace: "billing-ns", group: "billing-ns/orders" },
  ];
  const entries = searchEntries(nodes);

  test("ranks name prefixes, then substrings, then other fields", () => {
    expect(literalSearch(entries, "billing")?.map((n) => n.name)).toEqual([
      "billing",
      "billing-worker",
      "worker-billing",
      "orders",
    ]);
    expect(literalSearch(entries, "WORKER")?.map((n) => n.name)).toEqual([
      "worker-billing",
      "billing-worker",
    ]);
  });

  test("returns null without a literal match (fuzzy fallback)", () => {
    expect(literalSearch(entries, "bliling")).toBeNull();
    expect(literalSearch(entries, "  ")).toEqual([]);
  });
});

describe("canvas highlight", () => {
  const web = card("web", 0, 0);
  const failing = card("db", 0, 100, { health: "error" });

  test("dims outside the neighbourhood, the matches or the problems", () => {
    expect(cardAlpha(web, NONE)).toBe(1);
    const lit = { ...NONE, lit: { nodes: new Set(["db"]), edges: new Set<string>() } };
    expect(cardAlpha(web, lit)).toBe(DIM_ALPHA);
    expect(cardAlpha(failing, lit)).toBe(1);
    expect(cardAlpha(web, { ...NONE, matches: new Set(["web"]) })).toBe(1);
    expect(cardAlpha(web, { ...NONE, problems: true })).toBe(PROBLEMS_DIM_ALPHA);
    expect(cardAlpha(failing, { ...NONE, problems: true })).toBe(1);
  });

  test("dims groups without highlighted members", () => {
    const group = { id: "shop/web", health: "ok" } as SceneGroup;
    expect(groupDimmed(group, NONE)).toBe(false);
    expect(groupDimmed(group, { ...NONE, groups: new Set(["shop/db"]) })).toBe(true);
    expect(groupDimmed(group, { ...NONE, problems: true })).toBe(true);
  });

  test("maps the viewport to graph coordinates", () => {
    expect(viewRect({ x: -100, y: 50, zoom: 0.5, width: 800, height: 600, dpr: 1 })).toEqual({
      x: 200,
      y: -100,
      width: 1600,
      height: 1200,
    });
  });
});

describe("highlight flags", () => {
  test("only notify ids whose flags changed", () => {
    const flags = new HighlightFlags();
    const runs = { a: 0, b: 0, c: 0 };
    for (const id of ["a", "b", "c"] as const) {
      const flag = flags.of(id);
      effect(() => {
        void flag.value;
        runs[id]++;
      });
    }
    flags.apply(new Map([["a", FLAG_LIT], ["b", FLAG_LIT]]));
    expect(runs).toEqual({ a: 2, b: 2, c: 1 });
    flags.apply(new Map([["a", FLAG_LIT | FLAG_SELECTED], ["b", FLAG_LIT]]));
    expect(runs).toEqual({ a: 3, b: 2, c: 1 });
    flags.apply(new Map());
    expect(runs).toEqual({ a: 4, b: 3, c: 1 });
    expect(flags.of("late").value).toBe(0);
  });
});

describe("layout signature", () => {
  const labels = { app: "web" };
  const deployment = (available: number): GraphObject => ({
    kind: "Deployment",
    metadata: { name: "web", namespace: "shop", uid: "web", labels },
    spec: { replicas: 2, selector: { matchLabels: labels }, template: { metadata: { labels } } },
    status: { availableReplicas: available },
  });
  const service: GraphObject = {
    kind: "Service",
    metadata: { name: "web", namespace: "shop", uid: "svc" },
    spec: { selector: labels },
  };
  const expansion = { expanded: new Set<string>(), history: new Set<string>() };

  test("ignores health, follows structure", () => {
    const healthy = visibleGraph(buildTopology([deployment(2), service]), expansion);
    const failing = visibleGraph(buildTopology([deployment(0), service]), expansion);
    expect(layoutSignature(failing)).toBe(layoutSignature(healthy));
    const without = visibleGraph(buildTopology([deployment(2)]), expansion);
    expect(layoutSignature(without)).not.toBe(layoutSignature(healthy));
  });

  test("traces a neighbourhood from a prebuilt adjacency", () => {
    const topology = buildTopology([deployment(2), service]);
    const adjacency = buildAdjacency(topology.edges);
    expect(traceNeighbourhood(adjacency, "svc")).toEqual(
      traceNeighbourhood(topology.edges, "svc")
    );
    expect([...traceNeighbourhood(adjacency, "svc").nodes].sort()).toEqual(["svc", "web"]);
  });
});
