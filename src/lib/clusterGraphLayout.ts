/**
 * Layout of the resource graph. Pure (dagre only), deterministic and
 * memoised per application group:
 *
 * - every node has a known size (no DOM measuring, no layout flash);
 * - each group is laid out left to right with dagre (traffic flows
 *   Ingress -> Service -> Workload -> dependencies); objects without an edge
 *   inside the group are put in a compact grid next to it;
 * - groups are packed into one lane per namespace, lanes are stacked.
 *
 * Only groups whose structure changed are laid out again.
 */
import dagre from "@dagrejs/dagre";
import {
  AppGroup,
  CLUSTER_NAMESPACE,
  TopoEdge,
  TopoNode,
  VisibleGraph,
} from "./clusterGraph";

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 58;
/** Workload roots: the card plus their pod health strip. */
export const WORKLOAD_HEIGHT = 84;
export const POD_WIDTH = 210;
export const POD_HEIGHT = 44;

export const GROUP_PADDING = 16;
export const GROUP_HEADER = 40;
const GROUP_GAP = 28;
const LANE_GAP = 36;
export const LANE_HEADER = 30;
const NODE_SEP = 18;
const RANK_SEP = 64;
const GRID_GAP = 14;
/** Aspect ratio (width / height) the packed graph aims for. */
const TARGET_ASPECT = 1.6;

/** Size of a node's card. */
export function nodeSize(node: TopoNode): Size {
  if (node.category === "pod") return { width: POD_WIDTH, height: POD_HEIGHT };
  if (node.category === "workload") {
    return { width: CARD_WIDTH, height: WORKLOAD_HEIGHT };
  }
  return { width: CARD_WIDTH, height: CARD_HEIGHT };
}

/**
 * Everything the layout of a visible graph depends on: groups (in order),
 * nodes with their size and edges - not health or status. Equal signatures
 * give equal layouts, so a status-only change never re-lays out.
 */
export function layoutSignature(
  graph: VisibleGraph,
  sizeOf: (node: TopoNode) => Size = nodeSize
): string {
  const nodes = graph.nodes.map((node) => {
    const size = sizeOf(node);
    return `${node.id}@${node.group}:${size.width}x${size.height}`;
  });
  nodes.sort();
  const edges = graph.edges.map((edge) => edge.id);
  edges.sort();
  return `${graph.groups.map((group) => group.id).join("|")}#${nodes.join("|")}#${edges.join("|")}`;
}

interface GroupLayout {
  signature: string;
  /** Node positions relative to the group's content box. */
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * Edges that shape the left-to-right flow. A route's TLS secret is not a
 * step of the traffic flow: it is placed below instead of between the
 * route and its backends.
 */
const ranksFlow = (edge: TopoEdge, nodes: Map<string, TopoNode>) =>
  !(edge.type === "mounts" && nodes.get(edge.source)?.category === "traffic");

/** Groups up to this size use the (much faster) layered layout. */
const SMALL_GROUP = 40;

/**
 * Small layered layout (what dagre does, without its overhead): ranks by
 * longest path, sources pulled next to their targets (an HPA sits right
 * before its Deployment), barycenter ordering, ranks centred vertically.
 * Returns null for cyclic graphs (dagre handles those).
 */
export function layeredLayout(
  nodes: TopoNode[],
  edges: TopoEdge[],
  sizeOf: (node: TopoNode) => Size = nodeSize
): Map<string, { x: number; y: number }> | null {
  const ids = new Set(nodes.map((node) => node.id));
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    into.set(id, []);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    out.get(edge.source)!.push(edge.target);
    into.get(edge.target)!.push(edge.source);
  }

  /* Longest-path ranks (Kahn's order). */
  const sorted = [...nodes].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const indegree = new Map(sorted.map((node) => [node.id, into.get(node.id)!.length]));
  const queue = sorted.filter((node) => indegree.get(node.id) === 0).map((n) => n.id);
  const order: string[] = [];
  const rank = new Map<string, number>();
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    const r = rank.get(id) ?? 0;
    rank.set(id, r);
    for (const target of out.get(id)!) {
      rank.set(target, Math.max(rank.get(target) ?? 0, r + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (order.length !== nodes.length) return null;

  /* Pull nodes right, next to their closest target (sources first). */
  for (const id of [...order].reverse()) {
    const targets = out.get(id)!;
    if (targets.length === 0) continue;
    const closest = Math.min(...targets.map((target) => rank.get(target)!));
    rank.set(id, Math.max(rank.get(id)!, closest - 1));
  }

  const ranks: string[][] = [];
  for (const id of order) {
    const r = rank.get(id)!;
    (ranks[r] = ranks[r] || []).push(id);
  }
  for (const list of ranks) {
    if (list) list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  /* Barycenter sweeps to reduce crossings. */
  const index = new Map<string, number>();
  const reindex = () =>
    ranks.forEach((list) => list?.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (neighbours: Map<string, string[]>, list: string[]) => {
    const weight = new Map(
      list.map((id) => {
        const others = neighbours.get(id)!.filter((other) => index.has(other));
        const value = others.length
          ? others.reduce((sum, other) => sum + index.get(other)!, 0) / others.length
          : index.get(id)!;
        return [id, value];
      })
    );
    list.sort((a, b) => weight.get(a)! - weight.get(b)! || index.get(a)! - index.get(b)!);
    list.forEach((id, i) => index.set(id, i));
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r < ranks.length; r++) if (ranks[r]) sweep(into, ranks[r]);
    for (let r = ranks.length - 2; r >= 0; r--) if (ranks[r]) sweep(out, ranks[r]);
  }

  /* Coordinates: ranks left to right, each centred on the tallest. */
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const columnHeight = (list: string[]) =>
    list.reduce((sum, id) => sum + sizeOf(byId.get(id)!).height, 0) +
    NODE_SEP * (list.length - 1);
  const tallest = Math.max(...ranks.filter(Boolean).map(columnHeight));
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const list of ranks) {
    if (!list) continue;
    let y = (tallest - columnHeight(list)) / 2;
    let columnWidth = 0;
    for (const id of list) {
      const size = sizeOf(byId.get(id)!);
      positions.set(id, { x, y });
      y += size.height + NODE_SEP;
      columnWidth = Math.max(columnWidth, size.width);
    }
    x += columnWidth + RANK_SEP;
  }
  return positions;
}

/** Lays out the nodes of one group (relative coordinates). */
export function layoutGroup(
  nodes: TopoNode[],
  edges: TopoEdge[],
  sizeOf: (node: TopoNode) => Size = nodeSize
): Omit<GroupLayout, "signature"> {
  const positions = new Map<string, { x: number; y: number }>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const flowEdges = edges.filter((edge) => ranksFlow(edge, byId));
  const connected = new Set<string>();
  for (const edge of flowEdges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }

  let width = 0;
  let height = 0;

  const flow = nodes.filter((node) => connected.has(node.id));
  const layered =
    flow.length > 0 && flow.length <= SMALL_GROUP
      ? layeredLayout(flow, flowEdges, sizeOf)
      : null;
  if (layered) {
    for (const [id, position] of layered) {
      const size = sizeOf(byId.get(id)!);
      positions.set(id, position);
      width = Math.max(width, position.x + size.width);
      height = Math.max(height, position.y + size.height);
    }
  } else if (flow.length > 0) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: "LR",
      nodesep: NODE_SEP,
      ranksep: RANK_SEP,
      marginx: 0,
      marginy: 0,
      ranker: "network-simplex",
    });
    graph.setDefaultEdgeLabel(() => ({}));
    // Insert in a stable order so the same topology gives the same layout.
    const sorted = [...flow].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (const node of sorted) graph.setNode(node.id, { ...sizeOf(node) });
    for (const edge of [...flowEdges].sort((a, b) => a.id.localeCompare(b.id))) {
      graph.setEdge(edge.source, edge.target);
    }
    dagre.layout(graph);
    for (const node of sorted) {
      const laidOut = graph.node(node.id);
      const size = sizeOf(node);
      const x = laidOut.x - size.width / 2;
      const y = laidOut.y - size.height / 2;
      positions.set(node.id, { x, y });
      width = Math.max(width, x + size.width);
      height = Math.max(height, y + size.height);
    }
  }

  /*
   * Objects without a flow edge in the group: a compact grid below the
   * flow (as wide as the flow), or a wide grid on their own.
   */
  const loose = nodes
    .filter((node) => !connected.has(node.id))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  if (loose.length > 0) {
    const cell = loose.reduce(
      (max, node) => {
        const size = sizeOf(node);
        return {
          width: Math.max(max.width, size.width),
          height: Math.max(max.height, size.height),
        };
      },
      { width: 0, height: 0 }
    );
    const columns =
      flow.length > 0
        ? Math.max(1, Math.floor((width + GRID_GAP) / (cell.width + GRID_GAP)))
        : Math.max(1, Math.ceil(Math.sqrt(loose.length * 2)));
    const originY = flow.length > 0 ? height + NODE_SEP : 0;
    loose.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * (cell.width + GRID_GAP);
      const y = originY + row * (cell.height + GRID_GAP);
      positions.set(node.id, { x, y });
      const size = sizeOf(node);
      width = Math.max(width, x + size.width);
      height = Math.max(height, y + size.height);
    });
  }

  return { positions, width, height };
}

/* Kind order within a rank / grid: traffic first, config last. */
const CATEGORY_ORDER: Record<string, number> = {
  traffic: 0,
  service: 1,
  policy: 2,
  workload: 3,
  replicaset: 4,
  job: 4,
  pod: 5,
  identity: 6,
  config: 7,
  storage: 8,
};
const sortKey = (node: TopoNode) =>
  `${CATEGORY_ORDER[node.category] ?? 9}|${node.kind}|${node.name}`;

/** Order of groups within a namespace lane: apps by name, then shared, unused. */
const groupOrder = (group: AppGroup) =>
  `${group.type === "app" ? 0 : group.type === "shared" ? 1 : 2}|${group.name}`;

/**
 * Order of the groups in a lane: entry points (an Ingress routing to
 * several apps) directly followed by the apps they route to, so traffic
 * between groups reads left to right; the rest by name, shared and
 * unreferenced config last.
 */
export function flowOrder(
  groups: AppGroup[],
  crossEdges: Map<string, Set<string>>
): AppGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const sorted = [...groups].sort((a, b) =>
    groupOrder(a).localeCompare(groupOrder(b))
  );
  const incoming = new Set<string>();
  for (const [source, targets] of crossEdges) {
    if (!byId.has(source)) continue;
    for (const target of targets) incoming.add(target);
  }
  const ordered: AppGroup[] = [];
  const placed = new Set<string>();
  const visit = (group: AppGroup) => {
    if (placed.has(group.id) || group.type !== "app") return;
    placed.add(group.id);
    ordered.push(group);
    const targets = [...(crossEdges.get(group.id) || [])]
      .map((id) => byId.get(id))
      .filter((target): target is AppGroup => !!target)
      .sort((a, b) => groupOrder(a).localeCompare(groupOrder(b)));
    for (const target of targets) visit(target);
  };
  for (const group of sorted) {
    if (crossEdges.has(group.id) && !incoming.has(group.id)) visit(group);
  }
  for (const group of sorted) {
    if (group.type === "app") visit(group);
  }
  for (const group of sorted) {
    if (!placed.has(group.id)) ordered.push(group);
  }
  return ordered;
}

export interface GraphLayout {
  /** Absolute top-left positions of every visible node. */
  nodes: Map<string, { x: number; y: number }>;
  groups: Map<string, Rect>;
  lanes: { namespace: string; x: number; y: number; width: number; apps: number }[];
  /** Number of groups laid out (not from the cache) in this pass. */
  computed: number;
}

/**
 * Memoised layout: call `layout()` for every new visible graph; groups with
 * an unchanged structure keep their positions.
 */
export class GraphLayoutCache {
  private groups = new Map<string, GroupLayout>();
  /*
   * Row width of the last packing, kept while the set of groups stays the
   * same: expanding one workload must not reshuffle every lane.
   */
  private rowWidth: number | null = null;
  private groupSet = "";

  constructor(private sizeOf: (node: TopoNode) => Size = nodeSize) {}

  clear() {
    this.groups.clear();
    this.rowWidth = null;
    this.groupSet = "";
  }

  layout(graph: VisibleGraph): GraphLayout {
    const nodesByGroup = new Map<string, TopoNode[]>();
    for (const node of graph.nodes) {
      const list = nodesByGroup.get(node.group);
      if (list) list.push(node);
      else nodesByGroup.set(node.group, [node]);
    }
    const groupOf = new Map(graph.nodes.map((node) => [node.id, node.group]));
    const edgesByGroup = new Map<string, TopoEdge[]>();
    for (const edge of graph.edges) {
      const group = groupOf.get(edge.source);
      if (!group || group !== groupOf.get(edge.target)) continue;
      const list = edgesByGroup.get(group);
      if (list) list.push(edge);
      else edgesByGroup.set(group, [edge]);
    }

    let computed = 0;
    const layouts = new Map<string, GroupLayout>();
    for (const group of graph.groups) {
      const members = nodesByGroup.get(group.id) || [];
      const groupEdges = edgesByGroup.get(group.id) || [];
      const signature =
        members
          .map((node) => {
            const size = this.sizeOf(node);
            return `${node.id}:${size.width}x${size.height}`;
          })
          .sort()
          .join("|") +
        "#" +
        groupEdges
          .map((edge) => edge.id)
          .sort()
          .join("|");
      let cached = this.groups.get(group.id);
      if (!cached || cached.signature !== signature) {
        cached = { signature, ...layoutGroup(members, groupEdges, this.sizeOf) };
        computed++;
      }
      layouts.set(group.id, cached);
    }
    // Forget groups that are gone.
    this.groups = layouts;

    /* Lanes: one per namespace, cluster-scoped objects last. */
    const lanes = new Map<string, AppGroup[]>();
    for (const group of graph.groups) {
      const list = lanes.get(group.namespace);
      if (list) list.push(group);
      else lanes.set(group.namespace, [group]);
    }
    const laneOrder = [...lanes.keys()].sort((a, b) =>
      a === CLUSTER_NAMESPACE
        ? 1
        : b === CLUSTER_NAMESPACE
          ? -1
          : a.localeCompare(b)
    );

    const outer = (layout: GroupLayout): Size => ({
      width: layout.width + GROUP_PADDING * 2,
      height: layout.height + GROUP_PADDING * 2 + GROUP_HEADER,
    });
    const crossEdges = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      const source = groupOf.get(edge.source);
      const target = groupOf.get(edge.target);
      if (!source || !target || source === target) continue;
      const targets = crossEdges.get(source) || new Set<string>();
      targets.add(target);
      crossEdges.set(source, targets);
    }
    const orderedLanes = laneOrder.map((namespace) => ({
      namespace,
      groups: flowOrder(lanes.get(namespace)!, crossEdges),
    }));

    /* Shelf-pack every lane with a given row width. */
    const pack = (rowWidth: number) => {
      const rects = new Map<string, Rect>();
      const laneRects: GraphLayout["lanes"] = [];
      let y = 0;
      let width = 0;
      for (const { namespace, groups } of orderedLanes) {
        const laneTop = y;
        y += LANE_HEADER;
        let x = 0;
        let rowHeight = 0;
        let laneWidth = 0;
        for (const group of groups) {
          const size = outer(layouts.get(group.id)!);
          if (x > 0 && x + size.width > rowWidth) {
            x = 0;
            y += rowHeight + GROUP_GAP;
            rowHeight = 0;
          }
          rects.set(group.id, { x, y, ...size });
          x += size.width + GROUP_GAP;
          laneWidth = Math.max(laneWidth, x - GROUP_GAP);
          rowHeight = Math.max(rowHeight, size.height);
        }
        width = Math.max(width, laneWidth);
        laneRects.push({
          namespace,
          x: 0,
          y: laneTop,
          width: laneWidth,
          apps: groups.filter((group) => group.type === "app").length,
        });
        y += rowHeight + LANE_GAP;
      }
      return { rects, laneRects, width, height: Math.max(0, y - LANE_GAP) };
    };

    /*
     * Pick the row width whose result is closest to the canvas aspect
     * ratio (a fixed TARGET_ASPECT: the layout must not jump when the
     * window or side panel is resized).
     */
    let widest = 0;
    let total = 0;
    for (const layout of layouts.values()) {
      const size = outer(layout);
      widest = Math.max(widest, size.width);
      total += size.width + GROUP_GAP;
    }
    const groupSet = graph.groups.map((group) => group.id).join("|");
    const keep =
      groupSet === this.groupSet &&
      this.rowWidth !== null &&
      this.rowWidth >= widest;
    let best = pack(keep ? this.rowWidth! : widest);
    let bestScore = keep ? -Infinity : Infinity;
    const steps = 14;
    for (let step = 0; step <= steps && widest > 0 && !keep; step++) {
      const rowWidth = widest + ((total - widest) * step) / steps;
      const candidate = pack(rowWidth);
      if (candidate.height === 0) continue;
      const score = Math.abs(
        Math.log(candidate.width / candidate.height / TARGET_ASPECT)
      );
      if (score < bestScore - 0.01) {
        best = candidate;
        bestScore = score;
        this.rowWidth = rowWidth;
      }
    }
    if (!keep && bestScore === Infinity) this.rowWidth = widest;
    this.groupSet = groupSet;

    const nodes = new Map<string, { x: number; y: number }>();
    for (const [id, rect] of best.rects) {
      const layout = layouts.get(id)!;
      const originX = rect.x + GROUP_PADDING;
      const originY = rect.y + GROUP_HEADER + GROUP_PADDING;
      for (const [nodeId, position] of layout.positions) {
        nodes.set(nodeId, { x: originX + position.x, y: originY + position.y });
      }
    }
    const groupRects = best.rects;
    const laneRects = best.laneRects;

    return { nodes, groups: groupRects, lanes: laneRects, computed };
  }
}
