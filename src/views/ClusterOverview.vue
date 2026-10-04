<script setup lang="ts">
/*
 * Resource graph: a live topology of the applications in a context.
 *
 * Data: useClusterTopology (curated kinds, live refresh) -> buildTopology
 * (pure model: relationships, health, app groups) -> visibleGraph
 * (collapsed pods, filters) -> GraphLayoutCache (memoised per group) ->
 * vue-flow nodes / edges. Highlighting (selection, search, problems) lives
 * in a provided view state, so it never rebuilds the node list.
 */
import type { Edge, Node, NodeMouseEvent } from "@vue-flow/core";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import Fuse from "fuse.js";
import { useElementSize, useNow, useStorage } from "@vueuse/core";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CloudOff,
  Info,
  Loader2,
  Maximize,
  Pause,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
} from "lucide-vue-next";
import SpotlightGridContainer from "@/components/ui/SpotlightGridContainer.vue";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { Kbd } from "@/components/ui/kbd";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/ui/status";
import ContextAvatar from "@/components/ContextAvatar.vue";
import KindIcon from "@/components/KindIcon.vue";
import ObjectNode from "@/components/vue-flow/ObjectNode.vue";
import GroupNode from "@/components/vue-flow/GroupNode.vue";
import LaneNode from "@/components/vue-flow/LaneNode.vue";
import TopologyEdge from "@/components/vue-flow/TopologyEdge.vue";
import GraphLegend from "@/components/vue-flow/GraphLegend.vue";
import GraphMinimap from "@/components/vue-flow/GraphMinimap.vue";
import GraphInspector from "@/components/vue-flow/GraphInspector.vue";
import { GraphViewStateKey } from "@/components/vue-flow/graphState";
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  nodeSubtitle,
} from "@/components/vue-flow/nodeStatus";
import { cn, formatResourceKind, injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import {
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import {
  CLUSTER_NAMESPACE,
  GraphFilters,
  NodeCategory,
  TopoNode,
  VisibleGraph,
  isProblem,
  qualifiedResourceName,
  summarize,
  traceNeighbourhood,
  visibleGraph,
} from "@/lib/clusterGraph";
import {
  GraphLayoutCache,
  LANE_HEADER,
  Rect,
  nodeSize,
} from "@/lib/clusterGraphLayout";
import {
  GraphScope,
  useClusterTopology,
} from "@/composables/useClusterTopology";

/* ------------------------------------------------------------- scope -- */

const { context, namespace, kubeConfig, contexts, contextKubeConfigMapping } =
  injectStrict(KubeContextStateKey);

/*
 * The graph shows one context: the primary one, or the one picked here
 * when several contexts are active.
 */
const pickedContext = ref<string | null>(null);
const activeContexts = computed(() => [...contexts.value.keys()]);
const graphContext = computed(() =>
  pickedContext.value && contexts.value.has(pickedContext.value)
    ? pickedContext.value
    : context.value
);
const graphKubeConfig = computed(() =>
  graphContext.value === context.value
    ? kubeConfig.value
    : contextKubeConfigMapping.value.get(graphContext.value) || kubeConfig.value
);
/** Namespaces of the shown context; [] means all namespaces. */
const scopeNamespaces = computed<string[]>(() => {
  const active =
    contexts.value.get(graphContext.value) ||
    (namespace.value && graphContext.value === context.value
      ? [namespace.value]
      : []);
  return active.includes("all") ? [] : active;
});
const scope = computed<GraphScope | null>(() =>
  graphContext.value
    ? {
        context: graphContext.value,
        kubeConfig: graphKubeConfig.value,
        namespaces: scopeNamespaces.value,
      }
    : null
);
const scopeLabel = computed(() => {
  const namespaces = scopeNamespaces.value;
  if (namespaces.length === 0) return "All namespaces";
  if (namespaces.length === 1) return namespaces[0];
  return `${namespaces.length} namespaces`;
});

const {
  topology,
  loading,
  refreshing,
  progress,
  failedResources,
  loadError,
  refreshError,
  lastUpdated,
  timings,
  paused,
  refresh,
  retry,
} = useClusterTopology(scope);

/* -------------------------------------------------------- view state -- */

const selected = ref<string | null>(null);
const hovered = ref<string | null>(null);
const expanded = ref(new Set<string>());
const history = ref(new Set<string>());
const problems = ref(false);
const entering = ref(new Set<string>());
const zoom = ref(1);
/* Semantic zoom: less detail, larger labels when zoomed out. */
const far = computed(() => zoom.value < 0.45);
const overview = computed(() => zoom.value < 0.22);

const toggleIn = (set: Ref<Set<string>>, id: string) => {
  const next = new Set(set.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  set.value = next;
};

/* Filters (the view preferences persist, the selection does not). */
const hiddenCategories = useStorage<NodeCategory[]>(
  "graph-hidden-categories",
  // Service accounts are rarely what one looks for: hidden by default.
  ["identity"]
);
const showLegend = useStorage("graph-show-legend", true);
const namespaceFilter = ref<string[]>([]);
const labelFilter = ref("");
const showUnused = ref(false);
const filters = computed<GraphFilters>(() => ({
  namespaces: namespaceFilter.value,
  hiddenCategories: hiddenCategories.value,
  labels: labelFilter.value,
  problemsOnly: problems.value,
  showUnused: showUnused.value,
}));
const activeFilterCount = computed(
  () =>
    (namespaceFilter.value.length > 0 ? 1 : 0) +
    hiddenCategories.value.length +
    (labelFilter.value.trim() ? 1 : 0) +
    (showUnused.value ? 1 : 0)
);
const resetFilters = () => {
  namespaceFilter.value = [];
  hiddenCategories.value = [];
  labelFilter.value = "";
  showUnused.value = false;
};

const CATEGORY_FILTERS: { label: string; categories: NodeCategory[] }[] = [
  { label: "Ingresses & routes", categories: ["traffic"] },
  { label: "Services", categories: ["service"] },
  { label: "ConfigMaps & Secrets", categories: ["config"] },
  { label: "Volumes", categories: ["storage"] },
  { label: "Service accounts", categories: ["identity"] },
  { label: "Autoscalers & policies", categories: ["policy"] },
];
const isCategoryShown = (categories: NodeCategory[]) =>
  !categories.some((c) => hiddenCategories.value.includes(c));
const setCategoryShown = (categories: NodeCategory[], shown: boolean) => {
  const rest = hiddenCategories.value.filter((c) => !categories.includes(c));
  hiddenCategories.value = shown ? rest : [...rest, ...categories];
};

const namespacesInGraph = computed(() => {
  const namespaces = new Set<string>();
  for (const group of topology.value?.groups.values() || []) {
    if (group.namespace !== CLUSTER_NAMESPACE) namespaces.add(group.namespace);
  }
  return [...namespaces].sort();
});
const toggleNamespace = (name: string, shown: boolean) => {
  const current =
    namespaceFilter.value.length === 0
      ? [...namespacesInGraph.value]
      : [...namespaceFilter.value];
  const next = shown
    ? [...new Set([...current, name])]
    : current.filter((n) => n !== name);
  namespaceFilter.value =
    next.length === namespacesInGraph.value.length ? [] : next;
};

/* ------------------------------------------------------------- graph -- */

const EMPTY: VisibleGraph = { nodes: [], edges: [], groups: [] };
const visible = computed<VisibleGraph>(() =>
  topology.value
    ? visibleGraph(
        topology.value,
        { expanded: expanded.value, history: history.value },
        filters.value
      )
    : EMPTY
);
const visibleIds = computed(
  () => new Set(visible.value.nodes.map((node) => node.id))
);

const layoutCache = new GraphLayoutCache();
const lastLayoutMs = ref(0);
const layout = computed(() => {
  const started = performance.now();
  const result = layoutCache.layout(visible.value);
  lastLayoutMs.value = performance.now() - started;
  return result;
});

/*
 * Flow elements of the whole graph. Rendering is virtualised below: only
 * what is near the viewport is handed to vue-flow, so its per-frame work
 * does not grow with the cluster.
 */
const laneNodes = computed<Node[]>(() =>
  layout.value.lanes.map((lane) => ({
    id: `lane:${lane.namespace}`,
    type: "lane",
    position: { x: lane.x, y: lane.y },
    width: Math.max(lane.width, 200),
    height: LANE_HEADER - 6,
    data: { namespace: lane.namespace, apps: lane.apps },
    selectable: false,
    draggable: false,
    connectable: false,
    focusable: false,
    zIndex: 0,
  }))
);

const groupNodes = computed<(Node & { rect: Rect })[]>(() => {
  const { nodes: positions, groups: rects } = layout.value;
  const membersOf = new Map<string, TopoNode[]>();
  for (const node of visible.value.nodes) {
    const list = membersOf.get(node.group);
    if (list) list.push(node);
    else membersOf.set(node.group, [node]);
  }
  const result: (Node & { rect: Rect })[] = [];
  for (const group of visible.value.groups) {
    const rect = rects.get(group.id);
    if (!rect) continue;
    let pods = 0;
    let issues = 0;
    for (const id of group.nodeIds) {
      const node = topology.value!.nodes.get(id)!;
      if (node.parent) continue;
      pods += node.pods?.length || 0;
      if (isProblem(node.health)) issues++;
    }
    const members = membersOf.get(group.id) || [];
    result.push({
      id: `group:${group.id}`,
      type: "group",
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
      rect,
      data: {
        group,
        pods,
        problems: issues,
        members: members.map((node) => node.id),
        // Overview zoom: the group draws its members as health blocks.
        blocks: members.map((node) => {
          const position = positions.get(node.id)!;
          const size = nodeSize(node);
          return {
            id: node.id,
            x: position.x - rect.x,
            y: position.y - rect.y,
            width: size.width,
            height: size.height,
            health: node.missing ? "error" : node.health,
          };
        }),
      },
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      zIndex: 0,
    });
  }
  return result;
});

const cardNodes = computed(() => {
  const positions = layout.value.nodes;
  const cards = new Map<string, Node & { rect: Rect }>();
  for (const node of visible.value.nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const size = nodeSize(node);
    cards.set(node.id, {
      id: node.id,
      type: "k8s",
      position,
      width: size.width,
      height: size.height,
      rect: { ...position, ...size },
      data: { node: markRaw(node) },
      draggable: false,
      connectable: false,
      selectable: false,
      zIndex: 2,
      ariaLabel: `${node.kind} ${node.name}, ${HEALTH_LABEL[node.health]}`,
    });
  }
  return cards;
});

const allEdges = computed<Edge[]>(() => {
  const nodes = topology.value?.nodes;
  const cards = cardNodes.value;
  if (!nodes) return [];
  const result: Edge[] = [];
  for (const edge of visible.value.edges) {
    const source = nodes.get(edge.source)!;
    const target = nodes.get(edge.target)!;
    const from = cards.get(edge.source)?.rect;
    const to = cards.get(edge.target)?.rect;
    if (!from || !to) continue;
    result.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "topology",
      selectable: false,
      focusable: false,
      zIndex: 1,
      data: {
        type: edge.type,
        // Right side of the source card to the left side of the target.
        points: {
          sx: from.x + from.width,
          sy: from.y + from.height / 2,
          tx: to.x,
          ty: to.y + to.height / 2,
        },
        missing: !!target.missing || !!source.missing,
        crossGroup: source.group !== target.group,
        // Edges into shared / unreferenced groups (a StorageClass used by
        // many apps) stay faint until one of their ends is highlighted.
        faint:
          source.group !== target.group &&
          topology.value!.groups.get(target.group)?.type !== "app",
        problem: isProblem(source.health) || isProblem(target.health),
      },
    });
  }
  return result;
});

/** Neighbours per card: edges of a rendered card need both of their ends. */
const neighbours = computed(() => {
  const map = new Map<string, string[]>();
  for (const edge of visible.value.edges) {
    const a = map.get(edge.source);
    if (a) a.push(edge.target);
    else map.set(edge.source, [edge.target]);
    const b = map.get(edge.target);
    if (b) b.push(edge.source);
    else map.set(edge.target, [edge.source]);
  }
  return map;
});

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/*
 * Graph areas to render: the viewport plus a margin, snapped to a grid.
 * Groups follow the viewport every frame (they are cheap); cards follow
 * immediately while panning, but only once a zoom gesture settles, so
 * zooming out does not mount hundreds of cards mid-gesture.
 */
const renderWindow = shallowRef<Rect | null>(null);
const cardWindow = shallowRef<Rect | null>(null);

const flowNodes = computed<Node[]>(() => {
  const window = renderWindow.value;
  // Overview (and before the first viewport): groups draw their members.
  if (overview.value || !window) {
    return [...laneNodes.value, ...groupNodes.value];
  }
  const cardArea = cardWindow.value || window;
  const result: Node[] = laneNodes.value.filter((lane) =>
    intersects(window, {
      ...lane.position,
      width: lane.width as number,
      height: LANE_HEADER,
    })
  );
  for (const group of groupNodes.value) {
    if (intersects(window, group.rect)) result.push(group);
  }
  const rendered = new Set<string>();
  for (const [id, card] of cardNodes.value) {
    if (!intersects(cardArea, card.rect)) continue;
    rendered.add(id);
    for (const other of neighbours.value.get(id) || []) rendered.add(other);
  }
  for (const id of rendered) {
    const card = cardNodes.value.get(id);
    if (card) result.push(card);
  }
  return result;
});

const flowEdges = computed<Edge[]>(() => {
  if (overview.value || !renderWindow.value) return [];
  const rendered = new Set(flowNodes.value.map((node) => node.id));
  return allEdges.value.filter(
    (edge) => rendered.has(edge.source) && rendered.has(edge.target)
  );
});

/* -------------------------------------------------------- highlighting -- */

const lit = computed(() =>
  selected.value && visibleIds.value.has(selected.value)
    ? traceNeighbourhood(visible.value.edges, selected.value)
    : null
);

const search = ref("");
const searchInput = ref<InstanceType<typeof Input> | null>(null);
const searchOpen = ref(false);
const searchIndex = ref(0);
const fuse = computed(() => {
  const nodes = [...(topology.value?.nodes.values() || [])];
  return new Fuse(nodes, {
    keys: [
      { name: "name", weight: 3 },
      { name: "kind", weight: 1 },
      { name: "namespace", weight: 1 },
      { name: "group", weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  });
});
const searchResults = computed(() => {
  const query = search.value.trim();
  if (!query) return [];
  return fuse.value.search(query, { limit: 200 }).map((result) => result.item);
});
/** Visible node a (possibly collapsed) object is drawn as. */
const drawnAs = (node: TopoNode) =>
  visibleIds.value.has(node.id) ? node.id : node.parent || node.id;
const matches = computed(() => {
  if (!search.value.trim()) return null;
  return new Set(searchResults.value.map(drawnAs));
});
watch(search, () => {
  searchIndex.value = 0;
  searchOpen.value = true;
});

/*
 * Expanding / collapsing re-lays out a group (and the groups after it):
 * keep the toggled card where it is on screen.
 */
const keepInPlace = (id: string, change: () => void) => {
  const before = layout.value.nodes.get(id);
  change();
  nextTick(() => {
    const after = layout.value.nodes.get(id);
    if (!before || !after) return;
    const { x, y, zoom: scale } = viewport.value;
    setViewport({
      x: x - (after.x - before.x) * scale,
      y: y - (after.y - before.y) * scale,
      zoom: scale,
    });
  });
};

provide(GraphViewStateKey, {
  selected,
  hovered,
  lit,
  problems,
  matches,
  expanded,
  history,
  entering,
  far,
  overview,
  toggleExpanded: (id: string) => keepInPlace(id, () => toggleIn(expanded, id)),
  toggleHistory: (id: string) => keepInPlace(id, () => toggleIn(history, id)),
});

const summary = computed(() =>
  topology.value ? summarize(topology.value.groups.values()) : null
);
const problemNodeIds = computed(() =>
  visible.value.nodes
    .filter((node) => isProblem(node.health))
    .map((node) => node.id)
);

/* ---------------------------------------------------------- viewport -- */

const { setCenter, setViewport, zoomIn, zoomOut, dimensions, viewport } =
  useVueFlow();

watch(
  () => viewport.value.zoom,
  (value) => (zoom.value = value)
);

/* Render window: recomputed at most once per frame, and only changes when
 * the viewport moves past a grid step (small pans keep the same set). */
const WINDOW_GRID = 400;
let windowFrame = 0;
const updateWindow = () => {
  const { width, height } = dimensions.value;
  const { x, y, zoom: scale } = viewport.value;
  if (!width || !height || !scale) return;
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  const margin = Math.max(viewWidth, viewHeight) * 0.35;
  const snap = (value: number, up: boolean) =>
    (up ? Math.ceil(value / WINDOW_GRID) : Math.floor(value / WINDOW_GRID)) *
    WINDOW_GRID;
  const left = snap(-x / scale - margin, false);
  const top = snap(-y / scale - margin, false);
  const right = snap(-x / scale + viewWidth + margin, true);
  const bottom = snap(-y / scale + viewHeight + margin, true);
  const next = { x: left, y: top, width: right - left, height: bottom - top };
  const same = (rect: Rect | null) =>
    !!rect &&
    rect.x === next.x &&
    rect.y === next.y &&
    rect.width === next.width &&
    rect.height === next.height;
  if (!same(renderWindow.value)) renderWindow.value = next;

  clearTimeout(cardTimer);
  if (same(cardWindow.value)) return;
  if (scale === cardZoom || !cardWindow.value) {
    cardWindow.value = next;
    cardZoom = scale;
  } else {
    cardTimer = setTimeout(() => {
      cardWindow.value = renderWindow.value;
      cardZoom = viewport.value.zoom;
    }, 160);
  }
};
let cardTimer: ReturnType<typeof setTimeout> | undefined;
let cardZoom = 0;
watch(
  [viewport, dimensions],
  () => {
    cancelAnimationFrame(windowFrame);
    windowFrame = requestAnimationFrame(updateWindow);
  },
  { deep: true }
);

/* Animations pause while the view moves (cheaper frames). */
const moving = ref(false);

/* Zoom for CSS (overview label sizes), set without re-rendering the view. */
watch(zoom, (value) =>
  canvas.value?.style.setProperty("--graph-zoom", String(value))
);

/** Bounds of the whole graph (or of some nodes). */
const boundsOf = (ids?: string[]): Rect | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (rect: Rect) => {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  };
  if (ids) {
    for (const id of ids) {
      const card = cardNodes.value.get(id);
      if (card) add(card.rect);
    }
  } else {
    for (const rect of layout.value.groups.values()) add(rect);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Fit a graph area into the canvas (vue-flow only knows rendered nodes). */
const fitRect = (
  rect: Rect | null,
  options: { padding?: number; maxZoom?: number; duration?: number } = {}
) => {
  const { width, height } = dimensions.value;
  if (!rect || !width || !height) return;
  const padding = options.padding ?? 0.08;
  const scale = Math.min(
    width / (rect.width * (1 + padding * 2)),
    height / (rect.height * (1 + padding * 2)),
    options.maxZoom ?? 1
  );
  const zoomLevel = Math.max(0.05, scale);
  setViewport(
    {
      x: width / 2 - (rect.x + rect.width / 2) * zoomLevel,
      y: height / 2 - (rect.y + rect.height / 2) * zoomLevel,
      zoom: zoomLevel,
    },
    { duration: options.duration ?? 300 }
  );
};
const fitAll = (duration = 300) => fitRect(boundsOf(), { duration });

/*
 * Initial view: fit everything when it stays readable, else start at the
 * top-left at a readable zoom (the minimap shows the rest).
 */
const MIN_READABLE_ZOOM = 0.5;
const initialView = () => {
  const { width, height } = dimensions.value;
  const bounds = boundsOf();
  if (!width || !height || !bounds) return;
  const fitZoom = Math.min(
    width / (bounds.width * 1.16),
    height / (bounds.height * 1.16)
  );
  if (fitZoom >= MIN_READABLE_ZOOM) fitAll(0);
  else setViewport({ x: 24, y: 16, zoom: 0.75 });
};

const viewedScope = ref("");
const renderMs = ref(0);
let layoutDone = 0;
watch(layout, () => (layoutDone = performance.now()));

const onNodesInitialized = () => {
  renderMs.value = performance.now() - layoutDone;
  const key = JSON.stringify(scope.value);
  if (viewedScope.value !== key) {
    viewedScope.value = key;
    requestAnimationFrame(initialView);
  }
};

const focusNodes = (ids: string[], maxZoom = 1.1) => {
  if (ids.length === 0) return;
  fitRect(boundsOf(ids), { padding: 0.15, maxZoom, duration: 400 });
};

const centerOn = (id: string) => {
  const card = cardNodes.value.get(id);
  if (!card) return;
  const { rect } = card;
  setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    zoom: Math.max(viewport.value.zoom, 0.9),
    duration: 400,
  });
};

/* --------------------------------------------------------- selection -- */

const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const selectedNode = computed(() =>
  selected.value ? topology.value?.nodes.get(selected.value) || null : null
);

/*
 * The side panel shows the object's health, relationships and the regular
 * resource details (its header has Edit YAML / Describe / Logs).
 */
const openDetails = (node: TopoNode) => {
  if (!topology.value) return;
  setSidePanelComponent({
    title: `${node.kind}: ${node.name}`,
    icon: formatResourceKind(node.kind).toLowerCase(),
    // Raw: the panel state is reactive, the topology must not be proxied.
    component: markRaw(GraphInspector),
    props: {
      node: markRaw(node),
      topology: markRaw(topology.value),
      resource: node.object,
      onSelect: (id: string) => select(id, { center: true }),
      onFocus: () => focusSelection(),
    },
  });
};

/** Pan to a node when it ended up off screen (e.g. behind the panel). */
const ensureVisible = (id: string) => {
  const position = layout.value.nodes.get(id);
  const node = topology.value?.nodes.get(id);
  if (!position || !node) return;
  const size = nodeSize(node);
  const { x, y, zoom: scale } = viewport.value;
  const left = position.x * scale + x;
  const top = position.y * scale + y;
  const margin = 24;
  if (
    left < margin ||
    top < margin ||
    left + size.width * scale > dimensions.value.width - margin ||
    top + size.height * scale > dimensions.value.height - margin
  ) {
    centerOn(id);
  }
};

/*
 * A click opens the side panel a moment later: the panel narrows the
 * canvas, and the second click of a double-click must still land on the
 * node (not on the panel that slid in under the pointer).
 */
let panelTimer: ReturnType<typeof setTimeout> | undefined;

/** Select an object (expanding its workload when it is collapsed). */
const select = (
  id: string,
  options: { center?: boolean; panelDelay?: number } = {}
) => {
  const node = topology.value?.nodes.get(id);
  if (!node) return;
  if (node.parent && !expanded.value.has(node.parent)) {
    toggleIn(expanded, node.parent);
  }
  if (node.old && node.parent && !history.value.has(node.parent)) {
    toggleIn(history, node.parent);
  }
  selected.value = id;
  clearTimeout(panelTimer);
  const delay = options.panelDelay ?? 0;
  panelTimer = setTimeout(() => {
    if (selected.value !== id) return;
    openDetails(node);
    // Once the panel narrowed the canvas.
    setTimeout(() => {
      if (selected.value !== id) return;
      if (options.center) centerOn(id);
      else ensureVisible(id);
    }, 220);
  }, delay);
};

const focusSelection = () => {
  if (lit.value) focusNodes([...lit.value.nodes]);
};

const clearSelection = () => {
  clearTimeout(panelTimer);
  if (selected.value === null) return;
  selected.value = null;
  setSidePanelComponent(null);
};

/* Closing the side panel ends the selection. */
watch(sidePanel, (panel) => {
  if (!panel && selected.value) selected.value = null;
});

const onNodeClick = ({ node }: NodeMouseEvent) => {
  if (node.type !== "k8s") {
    clearSelection();
    return;
  }
  if (selected.value !== node.id) select(node.id, { panelDelay: 260 });
};

const onNodeDoubleClick = ({ node }: NodeMouseEvent) => {
  if (node.type !== "k8s") return;
  clearTimeout(panelTimer);
  const topoNode = topology.value?.nodes.get(node.id);
  selected.value = node.id;
  if (topoNode) openDetails(topoNode);
  // Fit the neighbourhood into the canvas the panel left.
  setTimeout(
    () =>
      focusNodes([...traceNeighbourhood(visible.value.edges, node.id).nodes]),
    240
  );
};

/* Keep the selection (and its panel) in sync with live refreshes. */
watch(topology, (next, previous) => {
  if (!selected.value) return;
  const node = next?.nodes.get(selected.value);
  if (!node) {
    clearSelection();
    return;
  }
  if (next !== previous) openDetails(node);
});

/* New objects of a live refresh fade in. */
let enteringTimer: ReturnType<typeof setTimeout> | undefined;
watch(visibleIds, (next, previous) => {
  if (!previous || previous.size === 0) return;
  const added = new Set([...next].filter((id) => !previous.has(id)));
  if (added.size === 0 || added.size === next.size) return;
  entering.value = added;
  clearTimeout(enteringTimer);
  enteringTimer = setTimeout(() => (entering.value = new Set()), 1200);
});

/* A new scope starts fresh. */
watch(
  () => JSON.stringify(scope.value),
  () => {
    clearSelection();
    expanded.value = new Set();
    history.value = new Set();
    namespaceFilter.value = [];
    layoutCache.clear();
  }
);

/*
 * Problems mode: only applications with a problem stay (re-laid out
 * compactly), healthy objects in them are dimmed, the view fits.
 */
const toggleProblems = () => {
  problems.value = !problems.value;
  clearSelection();
  // Once the re-laid-out graph is rendered.
  setTimeout(
    () => (problems.value ? fitAll() : initialView()),
    150
  );
};

const allExpanded = computed(() => {
  const roots = visible.value.nodes.filter(
    (node) => node.category === "workload" && !node.external
  );
  return roots.length > 0 && roots.every((node) => expanded.value.has(node.id));
});
const toggleExpandAll = () => {
  if (allExpanded.value) {
    expanded.value = new Set();
    history.value = new Set();
  } else {
    expanded.value = new Set(
      visible.value.nodes
        .filter((node) => node.category === "workload")
        .map((node) => node.id)
    );
  }
};

/* ----------------------------------------------------------- tooltip -- */

const canvas = ref<HTMLElement | null>(null);
const tooltip = ref<{ node: TopoNode; x: number; y: number } | null>(null);
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;

const onNodeMouseEnter = ({ node, event }: NodeMouseEvent) => {
  if (node.type !== "k8s") return;
  hovered.value = node.id;
  const topoNode = topology.value?.nodes.get(node.id);
  const rect = canvas.value?.getBoundingClientRect();
  const mouse = event as MouseEvent;
  clearTimeout(tooltipTimer);
  if (!topoNode || !rect) return;
  tooltipTimer = setTimeout(() => {
    const x = mouse.clientX - rect.left;
    const y = mouse.clientY - rect.top;
    tooltip.value = {
      node: topoNode,
      x: x > rect.width - 300 ? x - 296 : x + 16,
      y: Math.min(y + 16, rect.height - 180),
    };
  }, 350);
};
const onNodeMouseLeave = () => {
  hovered.value = null;
  clearTimeout(tooltipTimer);
  tooltip.value = null;
};
const tooltipLabels = computed(() =>
  Object.entries(tooltip.value?.node.labels || {})
    .filter(([key]) =>
      [
        "app.kubernetes.io/name",
        "app.kubernetes.io/instance",
        "app.kubernetes.io/version",
        "app",
        "tier",
      ].includes(key)
    )
    .slice(0, 3)
);

/* ------------------------------------------------------------ search -- */

const pickResult = (node: TopoNode) => {
  searchOpen.value = false;
  select(node.id, { center: true });
};
const onSearchKeydown = (event: KeyboardEvent) => {
  const results = searchResults.value.slice(0, 8);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchOpen.value = true;
    searchIndex.value = Math.min(searchIndex.value + 1, results.length - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    searchIndex.value = Math.max(searchIndex.value - 1, 0);
  } else if (event.key === "Enter") {
    const result = results[searchIndex.value];
    if (result) pickResult(result);
  } else if (event.key === "Escape") {
    event.stopPropagation();
    if (search.value) search.value = "";
    else (event.target as HTMLElement).blur();
  }
};

/* ---------------------------------------------------------- keyboard -- */

const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.isContentEditable)
  );
};
const onKeydown = (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target)) return;
  // Only when the graph is on screen (not behind a dialog / in a tab).
  if (!canvas.value || canvas.value.offsetParent === null) return;
  if (document.querySelector("[role=dialog]")) return;
  if (event.key === "/") {
    event.preventDefault();
    searchInput.value?.focus();
  } else if (event.key === "Escape") {
    if (search.value) search.value = "";
    else if (selected.value) clearSelection();
    else if (problems.value) problems.value = false;
  } else if (event.key === "f") {
    if (selected.value && lit.value) focusNodes([...lit.value.nodes]);
    else fitAll();
  } else if (event.key === "p") {
    toggleProblems();
  }
};
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  clearTimeout(tooltipTimer);
  clearTimeout(enteringTimer);
  clearTimeout(panelTimer);
  clearTimeout(cardTimer);
  cancelAnimationFrame(windowFrame);
});

/* ------------------------------------------------------------ status -- */

/* The toolbar gets narrow when the side panel is open. */
const toolbar = ref<HTMLElement | null>(null);
const { width: toolbarWidth } = useElementSize(toolbar);
const narrow = computed(
  () => toolbarWidth.value > 0 && toolbarWidth.value < 1080
);

const now = useNow({ interval: 1000 });
const updatedLabel = computed(() => {
  if (!lastUpdated.value) return "";
  const seconds = Math.max(
    0,
    Math.round((now.value.getTime() - lastUpdated.value.getTime()) / 1000)
  );
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
});

/* Timings for the performance harness (and the curious). */
watchEffect(() => {
  if (!timings.value) return;
  (window as any).__graphTimings = {
    ...timings.value,
    layoutMs: lastLayoutMs.value,
    renderMs: renderMs.value,
    nodes: flowNodes.value.length,
    edges: flowEdges.value.length,
    groups: visible.value.groups.length,
  };
});

/* Minimap: every group (not only the rendered ones) and the visible area. */
const minimapGroups = computed(() =>
  visible.value.groups
    .map((group) => ({
      id: group.id,
      rect: layout.value.groups.get(group.id)!,
      health: group.health,
      app: group.type === "app",
    }))
    .filter((group) => group.rect)
);
const graphBounds = computed(() => boundsOf());
const visibleArea = computed<Rect | null>(() => {
  const { width, height } = dimensions.value;
  const { x, y, zoom: scale } = viewport.value;
  if (!width || !scale) return null;
  return { x: -x / scale, y: -y / scale, width: width / scale, height: height / scale };
});
const navigateTo = (x: number, y: number) =>
  setCenter(x, y, { zoom: viewport.value.zoom, duration: 0 });

const showGraph = computed(
  () => !loadError.value && !loading.value && !!topology.value
);
</script>

<template>
  <div class="cluster-graph flex h-full w-full flex-col bg-background">
    <!-- Toolbar -->
    <div
      ref="toolbar"
      class="flex h-11 shrink-0 items-center gap-2 border-b bg-surface-1 px-2.5"
      role="toolbar"
      aria-label="Resource graph"
    >
      <DropdownMenu v-if="activeContexts.length > 1">
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            class="max-w-[220px] gap-1.5 px-1.5 [--avatar-ring:var(--surface-1)]"
            title="Context shown in the graph"
          >
            <ContextAvatar :name="graphContext" size="sm" />
            <span class="truncate font-medium">{{ graphContext }}</span>
            <ChevronsUpDown class="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            v-for="name in activeContexts"
            :key="name"
            @select="pickedContext = name"
          >
            <ContextAvatar :name="name" size="sm" />
            {{ name }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        v-else
        class="flex min-w-0 items-center gap-1.5 pl-0.5 text-sm [--avatar-ring:var(--surface-1)]"
      >
        <ContextAvatar v-if="graphContext" :name="graphContext" size="sm" />
        <span class="truncate font-medium text-foreground">{{
          graphContext
        }}</span>
      </div>
      <span v-if="!narrow" class="shrink-0 text-xs text-muted-foreground">{{
        scopeLabel
      }}</span>

      <span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

      <!-- Search -->
      <div :class="cn('relative shrink', narrow ? 'w-44' : 'w-64')">
        <Search
          class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref="searchInput"
          v-model="search"
          class="h-7 pl-8 pr-8 text-xs"
          placeholder="Find an object…"
          aria-label="Find an object"
          role="combobox"
          :aria-expanded="searchOpen && searchResults.length > 0"
          aria-controls="graph-search-results"
          @keydown="onSearchKeydown"
          @focus="searchOpen = true"
          @blur="searchOpen = false"
        />
        <Kbd
          v-if="!search"
          size="sm"
          class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
          >/</Kbd
        >
        <ul
          v-if="searchOpen && searchResults.length > 0"
          id="graph-search-results"
          role="listbox"
          class="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border bg-popover p-1 shadow-md animate-fade-in"
        >
          <li
            v-for="(result, index) in searchResults.slice(0, 8)"
            :key="result.id"
            role="option"
            :aria-selected="index === searchIndex"
            :class="
              cn(
                'flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-xs',
                index === searchIndex && 'bg-accent'
              )
            "
            @mousedown.prevent="pickResult(result)"
            @mouseenter="searchIndex = index"
          >
            <KindIcon
              :name="formatResourceKind(result.kind).toLowerCase()"
              class="h-3.5 w-3.5 text-muted-foreground"
            />
            <span class="truncate font-medium text-foreground">{{
              result.name
            }}</span>
            <span class="truncate text-muted-foreground"
              >{{ result.kind
              }}<template v-if="result.namespace">
                · {{ result.namespace }}</template
              ></span
            >
            <StatusDot
              v-if="result.health !== 'neutral'"
              :tone="HEALTH_TONE[result.health]"
              size="sm"
              class="ml-auto"
            />
          </li>
          <li
            v-if="searchResults.length > 8"
            class="px-2 py-1 text-2xs text-muted-foreground"
          >
            {{ searchResults.length - 8 }} more highlighted in the graph
          </li>
        </ul>
      </div>

      <!-- Filters -->
      <Popover>
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="gap-1.5">
            <SlidersHorizontal class="h-3.5 w-3.5" />
            Filters
            <span
              v-if="activeFilterCount > 0"
              class="rounded-sm bg-primary/15 px-1 text-2xs font-semibold tabular-nums text-link"
              >{{ activeFilterCount }}</span
            >
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-72 p-0">
          <div class="space-y-3 p-3">
            <section>
              <h3 class="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Show
              </h3>
              <label
                v-for="option in CATEGORY_FILTERS"
                :key="option.label"
                class="flex cursor-pointer items-center gap-2 py-1 text-sm"
              >
                <Checkbox
                  :checked="isCategoryShown(option.categories)"
                  @update:checked="(value: boolean) => setCategoryShown(option.categories, value)"
                />
                {{ option.label }}
              </label>
            </section>
            <section v-if="namespacesInGraph.length > 1">
              <h3 class="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Namespaces
              </h3>
              <div class="max-h-40 overflow-y-auto">
                <label
                  v-for="name in namespacesInGraph"
                  :key="name"
                  class="flex cursor-pointer items-center gap-2 py-1 text-sm"
                >
                  <Checkbox
                    :checked="
                      namespaceFilter.length === 0 ||
                      namespaceFilter.includes(name)
                    "
                    @update:checked="(value: boolean) => toggleNamespace(name, value)"
                  />
                  <span class="truncate">{{ name }}</span>
                </label>
              </div>
            </section>
            <section>
              <h3 class="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Labels
              </h3>
              <Input
                v-model="labelFilter"
                class="h-7 font-mono text-xs"
                placeholder="app=web, tier!=db"
                aria-label="Label selector"
              />
            </section>
            <section class="space-y-2">
              <label class="flex cursor-pointer items-center justify-between gap-2 text-sm">
                Show unreferenced config
                <Switch v-model:checked="showUnused" />
              </label>
            </section>
          </div>
          <div class="flex justify-end border-t border-border-subtle p-2">
            <Button
              variant="ghost"
              size="xs"
              :disabled="activeFilterCount === 0"
              @click="resetFilters"
              >Reset filters</Button
            >
          </div>
        </PopoverContent>
      </Popover>

      <Button
        :variant="problems ? 'secondary' : 'ghost'"
        size="sm"
        class="gap-1.5"
        :aria-pressed="problems"
        title="Dim healthy objects and zoom to problems (P)"
        @click="toggleProblems"
      >
        <TriangleAlert
          :class="
            cn(
              'h-3.5 w-3.5',
              summary && summary.failing > 0
                ? 'text-destructive'
                : summary && summary.degraded > 0
                  ? 'text-warning'
                  : ''
            )
          "
        />
        Problems
        <span
          v-if="problemNodeIds.length > 0"
          class="rounded-sm bg-destructive/10 px-1 text-2xs font-semibold tabular-nums text-destructive"
          >{{ problemNodeIds.length }}</span
        >
      </Button>

      <!-- Summary + live status -->
      <div class="ml-auto flex min-w-0 items-center gap-3 text-xs">
        <div
          v-if="summary && showGraph"
          class="flex items-center gap-1 whitespace-nowrap tabular-nums"
          aria-label="Application health"
        >
          <span class="mr-1 text-foreground"
            ><span class="font-semibold">{{ summary.apps }}</span>
            <span class="text-muted-foreground"> apps</span></span
          >
          <span
            class="inline-flex items-center gap-1 rounded px-1 text-muted-foreground"
            :title="`${summary.healthy} healthy`"
            ><StatusDot tone="success" size="sm" />{{ summary.healthy
            }}<span class="hidden 2xl:inline">&nbsp;healthy</span></span
          >
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded px-1 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground disabled:pointer-events-none"
            :title="`${summary.degraded} degraded: show problems`"
            :disabled="summary.degraded === 0"
            @click="!problems && toggleProblems()"
          >
            <StatusDot tone="warning" size="sm" />{{ summary.degraded
            }}<span class="hidden 2xl:inline">&nbsp;degraded</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded px-1 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground disabled:pointer-events-none"
            :title="`${summary.failing} failing: show problems`"
            :disabled="summary.failing === 0"
            @click="!problems && toggleProblems()"
          >
            <StatusDot
              tone="destructive"
              size="sm"
              :pulse="summary.failing > 0"
            />{{ summary.failing
            }}<span class="hidden 2xl:inline">&nbsp;failing</span>
          </button>
        </div>
        <span class="mx-0.5 hidden h-5 w-px bg-border lg:block" aria-hidden="true" />
        <span
          v-if="refreshError"
          class="inline-flex items-center gap-1 text-warning"
          :title="refreshError"
          ><TriangleAlert class="h-3 w-3" /> Refresh failed</span
        >
        <span
          v-else-if="failedResources.length > 0 && showGraph"
          class="inline-flex items-center gap-1 text-warning"
          :title="`Not loaded: ${failedResources.map(qualifiedResourceName).join(', ')}`"
          ><TriangleAlert class="h-3 w-3" /> {{ failedResources.length }} kind{{
            failedResources.length === 1 ? "" : "s"
          }}
          not loaded</span
        >
        <span
          v-if="showGraph"
          class="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
          aria-live="polite"
          :title="paused ? 'Live updates paused' : updatedLabel"
        >
          <span
            :class="
              cn(
                'h-1.5 w-1.5 rounded-full',
                paused ? 'bg-muted-foreground/60' : 'bg-success'
              )
            "
            aria-hidden="true"
          />
          <span v-if="!narrow">{{ paused ? "Paused" : updatedLabel }}</span>
          <span v-else class="sr-only">{{
            paused ? "Paused" : updatedLabel
          }}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="paused ? 'Resume live updates' : 'Pause live updates'"
          :title="paused ? 'Resume live updates' : 'Pause live updates'"
          @click="paused = !paused"
        >
          <Play v-if="paused" class="h-3.5 w-3.5" />
          <Pause v-else class="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh now"
          title="Refresh now"
          @click="refresh"
        >
          <RefreshCw :class="cn('h-3.5 w-3.5', refreshing && 'animate-spin')" />
        </Button>
      </div>
    </div>

    <!-- Canvas -->
    <div ref="canvas" class="relative min-h-0 flex-1">
      <SpotlightGridContainer>
        <div
          v-if="loadError"
          role="alert"
          class="absolute inset-0 z-10 flex items-center justify-center p-4"
        >
          <EmptyState
            :icon="CloudOff"
            title="Failed to load the resource graph"
            class="max-w-xl"
          >
            <pre
              class="whitespace-pre-wrap break-words font-mono text-xs select-text"
              >{{ loadError }}</pre
            >
            <template #action>
              <Button variant="outline" size="sm" @click="retry">
                <RefreshCw class="h-3.5 w-3.5" />
                Retry
              </Button>
            </template>
          </EmptyState>
        </div>
        <div
          v-else-if="loading"
          class="absolute inset-0 z-10 flex items-center justify-center"
          role="status"
        >
          <div class="w-72 rounded-xl border bg-popover p-4 text-sm shadow-lg">
            <div class="flex items-center gap-2 font-medium text-foreground">
              <Loader2 class="h-4 w-4 animate-spin text-primary" />
              {{
                progress.total === 0
                  ? "Discovering resources…"
                  : "Mapping the cluster…"
              }}
            </div>
            <div v-if="progress.total > 0" class="mt-3 space-y-1.5">
              <Progress
                :model-value="Math.round((progress.done / progress.total) * 100)"
              />
              <div class="text-right text-xs tabular-nums text-muted-foreground">
                {{ progress.done }} / {{ progress.total }} resource types
              </div>
            </div>
          </div>
        </div>
        <div
          v-else-if="showGraph && visible.groups.length === 0"
          class="absolute inset-0 z-10 flex items-center justify-center p-4"
        >
          <EmptyState
            :icon="activeFilterCount > 0 ? SlidersHorizontal : Info"
            :title="
              activeFilterCount > 0
                ? 'Nothing matches the filters'
                : 'Nothing is running here'
            "
            :description="
              activeFilterCount > 0
                ? 'Loosen or reset the filters to see more of the cluster.'
                : `No workloads, services or ingresses in ${scopeLabel.toLowerCase()} of ${graphContext}.`
            "
            class="max-w-md"
          >
            <template v-if="activeFilterCount > 0" #action>
              <Button variant="outline" size="sm" @click="resetFilters"
                >Reset filters</Button
              >
            </template>
          </EmptyState>
        </div>

        <VueFlow
          v-if="showGraph"
          :nodes="flowNodes"
          :edges="flowEdges"
          :min-zoom="0.05"
          :max-zoom="2"
          :nodes-draggable="false"
          :nodes-connectable="false"
          :elements-selectable="false"
          :zoom-on-double-click="false"
          :only-render-visible-elements="false"
          :fit-view-on-init="false"
          :class="[
            'graph-flow',
            far && 'graph-flow--far',
            overview && 'graph-flow--overview',
            moving && 'graph-flow--moving',
          ]"
          @node-click="onNodeClick"
          @node-double-click="onNodeDoubleClick"
          @node-mouse-enter="onNodeMouseEnter"
          @node-mouse-leave="onNodeMouseLeave"
          @pane-click="clearSelection"
          @nodes-initialized="onNodesInitialized"
          @move-start="moving = true"
          @move-end="moving = false"
        >
          <template #node-k8s="props">
            <ObjectNode v-bind="props" />
          </template>
          <template #node-group="props">
            <GroupNode v-bind="props" />
          </template>
          <template #node-lane="props">
            <LaneNode v-bind="props" />
          </template>
          <template #edge-topology="props">
            <TopologyEdge v-bind="props" />
          </template>
        </VueFlow>

        <!-- Hover card -->
        <div
          v-if="tooltip && showGraph"
          class="pointer-events-none absolute z-30 w-72 rounded-lg border bg-popover px-3 py-2.5 text-xs shadow-md animate-fade-in"
          :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }"
          role="tooltip"
        >
          <div class="flex items-center gap-1.5 text-muted-foreground">
            <KindIcon
              :name="formatResourceKind(tooltip.node.kind).toLowerCase()"
              class="h-3 w-3"
            />
            {{ tooltip.node.kind
            }}<template v-if="tooltip.node.namespace">
              · {{ tooltip.node.namespace }}</template
            >
          </div>
          <div class="mt-0.5 break-all font-medium text-foreground">
            {{ tooltip.node.name }}
          </div>
          <div class="mt-1 flex items-center gap-1.5">
            <StatusDot :tone="HEALTH_TONE[tooltip.node.health]" size="sm" />
            <span class="text-foreground/90">{{
              tooltip.node.missing ? "Missing" : HEALTH_LABEL[tooltip.node.health]
            }}</span>
            <span class="truncate text-muted-foreground">· {{ nodeSubtitle(tooltip.node) }}</span>
          </div>
          <ul v-if="tooltip.node.reasons.length > 0" class="mt-1.5 space-y-0.5">
            <li
              v-for="reason in tooltip.node.reasons.slice(0, 4)"
              :key="reason"
              :class="
                tooltip.node.health === 'error'
                  ? 'text-destructive'
                  : 'text-warning'
              "
            >
              {{ reason }}
            </li>
          </ul>
          <div
            v-if="tooltipLabels.length > 0"
            class="mt-1.5 flex flex-wrap gap-1"
          >
            <span
              v-for="[key, value] in tooltipLabels"
              :key="key"
              class="truncate rounded-sm bg-muted px-1 font-mono text-2xs text-muted-foreground"
              >{{ key.replace("app.kubernetes.io/", "") }}={{ value }}</span
            >
          </div>
          <div class="mt-1.5 border-t border-border-subtle pt-1.5 text-2xs text-muted-foreground">
            Click to inspect · double-click to focus
          </div>
        </div>

        <GraphMinimap
          v-if="showGraph && graphBounds && visible.groups.length > 0"
          class="absolute bottom-3 right-3 z-10"
          :groups="minimapGroups"
          :bounds="graphBounds"
          :view="visibleArea"
          @navigate="navigateTo"
        />

        <!-- Controls + legend -->
        <div
          v-if="showGraph && visible.groups.length > 0"
          class="absolute bottom-3 left-3 z-10 flex items-end gap-2"
        >
          <div
            class="flex flex-col gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md"
            role="toolbar"
            aria-label="Graph controls"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              title="Zoom in"
              @click="zoomIn({ duration: 150 })"
            >
              <ZoomIn class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              title="Zoom out"
              @click="zoomOut({ duration: 150 })"
            >
              <ZoomOut class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fit to view"
              title="Fit to view (F)"
              @click="fitAll()"
            >
              <Maximize class="h-3.5 w-3.5" />
            </Button>
            <span class="mx-1 h-px bg-border" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="allExpanded ? 'Collapse all pods' : 'Expand all pods'"
              :title="allExpanded ? 'Collapse all pods' : 'Expand all pods'"
              @click="toggleExpandAll"
            >
              <ChevronsDownUp v-if="allExpanded" class="h-3.5 w-3.5" />
              <ChevronsUpDown v-else class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="showLegend ? 'Hide legend' : 'Show legend'"
              :title="showLegend ? 'Hide legend' : 'Show legend'"
              :aria-pressed="showLegend"
              @click="showLegend = !showLegend"
            >
              <Info class="h-3.5 w-3.5" />
            </Button>
          </div>
          <GraphLegend v-if="showLegend" @close="showLegend = false" />
        </div>
      </SpotlightGridContainer>
    </div>
  </div>
</template>

<style>
@import "@vue-flow/core/dist/style.css";
@import "@vue-flow/core/dist/theme-default.css";

/* Nodes are fully drawn by their components. */
.cluster-graph .vue-flow__node-k8s,
.cluster-graph .vue-flow__node-group,
.cluster-graph .vue-flow__node-lane {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: inherit;
  cursor: default;
}
.cluster-graph .vue-flow__node-k8s {
  cursor: pointer;
}
.cluster-graph .vue-flow__node-group,
.cluster-graph .vue-flow__node-lane {
  pointer-events: none !important;
}
.cluster-graph .vue-flow__node:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
  border-radius: var(--radius);
}

/* Handles only anchor edges. */
.cluster-graph .graph-handle {
  opacity: 0;
  pointer-events: none;
  min-width: 0;
  min-height: 0;
  width: 1px;
  height: 1px;
  border: 0;
}

/* Edges: one style per relationship type. */
.graph-edge {
  stroke: hsl(var(--muted-foreground) / 0.45);
  stroke-width: 1.4;
  fill: none;
  transition:
    opacity 160ms ease-out,
    stroke-width 160ms ease-out;
}
.graph-edge--owns {
  stroke: hsl(var(--muted-foreground) / 0.4);
}
.graph-edge--routes {
  stroke: hsl(var(--info) / 0.75);
  stroke-width: 1.6;
  stroke-dasharray: 6 4;
  animation: graph-flow 1.1s linear infinite;
}
.graph-edge--selects {
  stroke: hsl(var(--muted-foreground) / 0.5);
  stroke-dasharray: 1.5 3.5;
  stroke-linecap: round;
}
.graph-edge--mounts {
  stroke: hsl(var(--muted-foreground) / 0.38);
  stroke-dasharray: 4 3;
}
.graph-edge--scales {
  stroke: hsl(var(--primary) / 0.65);
  stroke-dasharray: 8 3 2 3;
}
.graph-edge--missing {
  stroke: hsl(var(--destructive) / 0.8);
  stroke-dasharray: 4 3;
  animation: none;
}
.graph-edge--cross {
  opacity: 0.55;
}
.graph-edge--lit {
  stroke-width: 2.2;
  opacity: 1;
}
.graph-edge--lit.graph-edge--owns,
.graph-edge--lit.graph-edge--mounts,
.graph-edge--lit.graph-edge--selects {
  stroke: hsl(var(--primary) / 0.85);
}
.graph-edge--dim {
  opacity: 0.1;
}
.graph-edge--faint {
  opacity: 0.12;
}
.graph-edge--legend {
  animation: none;
}
.graph-edge-end {
  fill: hsl(var(--muted-foreground) / 0.55);
}
.graph-edge-end--routes {
  fill: hsl(var(--info));
}
.graph-edge-end--scales {
  fill: hsl(var(--primary));
}
.graph-edge-end--missing {
  fill: hsl(var(--destructive));
}
/* Pause continuous animations while panning / zooming. */
.graph-flow--moving .graph-edge--routes,
.graph-flow--moving .graph-ping {
  animation: none;
}
.graph-card--enter {
  animation: graph-enter 450ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes graph-enter {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
@keyframes graph-flow {
  to {
    stroke-dashoffset: -20;
  }
}
@media (prefers-reduced-motion: reduce) {
  .graph-edge--routes {
    animation: none;
    stroke-dasharray: none;
  }
  .graph-card--enter {
    animation: none;
  }
}

/* Far zoom: cards and groups trade detail for legible names. */
.graph-flow--far .graph-card__meta {
  visibility: hidden;
}
.graph-flow--far .graph-card__name {
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
  overflow: visible;
}
.graph-flow--far .graph-group__title {
  font-size: 22px;
  line-height: 28px;
}
.graph-flow--far .graph-lane__title {
  font-size: 20px;
  line-height: 26px;
}
.graph-flow--far .graph-edge--routes {
  animation: none;
}
/* Overview: group and namespace titles keep a readable on-screen size. */
.graph-flow--overview .graph-group__overview-title {
  font-size: calc(13px / var(--graph-zoom));
  line-height: 1.4;
}
/* Namespace titles would overlap the rows at this scale. */
.graph-flow--overview .graph-lane {
  visibility: hidden;
}
.graph-flow--overview .graph-edge {
  opacity: 0.35;
}

</style>
