<script setup lang="ts">
/*
 * Resource graph: a live topology of the applications in a context.
 *
 * Data: useClusterTopology (shared discovery; WatchHub watches with a
 * kubectl fallback) -> buildTopology + reconcileTopology (pure model;
 * unchanged parts keep their identity) -> visibleGraph (collapsed pods,
 * filters) -> GraphLayoutCache (memoised per group, skipped while the
 * structure is unchanged) -> a scene: lanes and groups (and, zoomed out,
 * every card) drawn on one canvas, detailed vue-flow cards near the
 * viewport when zoomed in. Highlighting (selection, search, problems) is
 * per-id flags plus one class on the canvas: it never rebuilds the node
 * list and only re-renders cards whose flags changed.
 */
import type { Edge, Node, NodeMouseEvent } from "@vue-flow/core";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import Fuse from "fuse.js";
import { useElementSize, useNow, useStorage } from "@vueuse/core";
import {
  Check,
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
import TopologyEdge from "@/components/vue-flow/TopologyEdge.vue";
import GraphCanvas from "@/components/vue-flow/GraphCanvas.vue";
import GraphLegend from "@/components/vue-flow/GraphLegend.vue";
import GraphMinimap from "@/components/vue-flow/GraphMinimap.vue";
import GraphInspector from "@/components/vue-flow/GraphInspector.vue";
import {
  FLAG_ENTER,
  FLAG_HOVER,
  FLAG_LEAVE,
  FLAG_LIT,
  FLAG_MATCH,
  FLAG_SELECTED,
  GraphViewStateKey,
  HighlightFlags,
} from "@/components/vue-flow/graphState";
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  kindLabel,
  nodeSubtitle,
} from "@/components/vue-flow/nodeStatus";
import { cn, formatResourceKind, injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { kubectlPollingForced } from "@/lib/multicontext";
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
  buildAdjacency,
  isProblem,
  qualifiedResourceName,
  summarize,
  traceNeighbourhood,
  visibleGraph,
} from "@/lib/clusterGraph";
import {
  GraphLayout,
  GraphLayoutCache,
  Rect,
  layoutSignature,
  nodeSize,
} from "@/lib/clusterGraphLayout";
import type {
  Scene,
  SceneCard,
  SceneEdge,
  SceneGroup,
  SceneHighlight,
} from "@/lib/clusterGraphCanvas";
import {
  Direction,
  GraphLod,
  SpatialIndex,
  literalSearch,
  lodForZoom,
  nearestInDirection,
  searchEntries,
} from "@/lib/clusterGraphView";
import {
  GRAPH_REFRESH_INTERVAL,
  GraphScope,
  useClusterTopology,
} from "@/composables/useClusterTopology";

/* ------------------------------------------------------------- scope -- */

const { context, namespace, kubeConfig, contexts, contextKubeConfigMapping } =
  injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);

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
  change,
  loading,
  refreshing,
  progress,
  failedResources,
  loadError,
  refreshError,
  lastUpdated,
  timings,
  paused,
  mode: sourceMode,
  refresh,
  retry,
} = useClusterTopology(scope, {
  forcePolling: () => kubectlPollingForced(settings.value),
});

/* -------------------------------------------------------- view state -- */

const selected = ref<string | null>(null);
const hovered = ref<string | null>(null);
const expanded = ref(new Set<string>());
const history = ref(new Set<string>());
const problems = ref(false);
/** Cards added by the last live update (fade in). */
const entering = shallowRef(new Set<string>());
const zoom = ref(1);
/* Semantic zoom (see lodForZoom), switched once a zoom gesture settles. */
const lod = ref<GraphLod>("cards");

const toggleIn = (set: Ref<Set<string>>, id: string) => {
  const next = new Set(set.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  set.value = next;
};

/* Filters (the view preferences persist, the selection does not). */
/* Service accounts are rarely what one looks for: hidden by default. */
const DEFAULT_HIDDEN: NodeCategory[] = ["identity"];
const hiddenCategories = useStorage<NodeCategory[]>(
  "graph-hidden-categories",
  [...DEFAULT_HIDDEN]
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
    // Categories shown / hidden other than the defaults.
    new Set([
      ...hiddenCategories.value.filter((c) => !DEFAULT_HIDDEN.includes(c)),
      ...DEFAULT_HIDDEN.filter((c) => !hiddenCategories.value.includes(c)),
    ]).size +
    (labelFilter.value.trim() ? 1 : 0) +
    (showUnused.value ? 1 : 0)
);
const resetFilters = () => {
  namespaceFilter.value = [];
  hiddenCategories.value = [...DEFAULT_HIDDEN];
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
/* Edges by source / target: built once per graph, used by every query. */
const adjacency = computed(() => buildAdjacency(visible.value.edges));

/*
 * Layout: memoised per group (GraphLayoutCache), and skipped entirely
 * while the structure is unchanged - a status-only live update keeps every
 * position (and the viewport) as it is.
 */
const layoutCache = new GraphLayoutCache();
/* Duration of the last layout pass (for the timings), not reactive. */
let lastLayoutMs = 0;
let layoutRuns = 0;
/* The graph laid out last (read by `layout` without depending on it). */
let laidOut: VisibleGraph = EMPTY;
const structure = computed(() => {
  laidOut = visible.value;
  return layoutSignature(visible.value);
});
const layout = computed<GraphLayout>(() => {
  void structure.value;
  const started = performance.now();
  const result = layoutCache.layout(laidOut);
  lastLayoutMs = performance.now() - started;
  layoutRuns++;
  return result;
});

/* -------------------------------------------------------------- scene -- */

/*
 * What is drawn: scene items keep their identity while their node and
 * position do, so live updates only touch what changed.
 */
interface CardEntry {
  node: TopoNode;
  position: { x: number; y: number };
  card: SceneCard;
}
let cardCache = new Map<string, CardEntry>();
const cardSubtitle = (node: TopoNode) => {
  const subtitle = nodeSubtitle(node);
  if (node.missing || node.category === "pod") return subtitle;
  return subtitle.startsWith(node.kind)
    ? `${kindLabel(node.kind)}${subtitle.slice(node.kind.length)}`
    : `${kindLabel(node.kind)} · ${subtitle}`;
};
const sceneCards = computed(() => {
  const positions = layout.value.nodes;
  const next = new Map<string, CardEntry>();
  const list: SceneCard[] = [];
  const byId = new Map<string, SceneCard>();
  for (const node of visible.value.nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    let entry = cardCache.get(node.id);
    if (!entry || entry.node !== node || entry.position !== position) {
      const size = nodeSize(node);
      entry = {
        node,
        position,
        card: {
          id: node.id,
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          name: node.name,
          subtitle: cardSubtitle(node),
          health: node.health,
          category: node.category,
          missing: !!node.missing,
          external: !!node.external,
          compact: node.category === "pod",
          group: node.group,
        },
      };
    }
    next.set(node.id, entry);
    list.push(entry.card);
    byId.set(node.id, entry.card);
  }
  cardCache = next;
  return { list, byId, index: new SpatialIndex(list) };
});

const sceneGroups = computed<SceneGroup[]>(() => {
  const nodes = topology.value?.nodes;
  const rects = layout.value.groups;
  const membersOf = new Map<string, SceneCard[]>();
  for (const card of sceneCards.value.list) {
    const list = membersOf.get(card.group);
    if (list) list.push(card);
    else membersOf.set(card.group, [card]);
  }
  const result: SceneGroup[] = [];
  for (const group of visible.value.groups) {
    const rect = rects.get(group.id);
    if (!rect || !nodes) continue;
    let pods = 0;
    let issues = 0;
    for (const id of group.nodeIds) {
      const node = nodes.get(id);
      if (!node || node.parent) continue;
      pods += node.pods?.length || 0;
      if (isProblem(node.health)) issues++;
    }
    result.push({
      id: group.id,
      ...rect,
      title:
        group.type === "shared"
          ? "Shared"
          : group.type === "unused"
            ? "Unreferenced"
            : group.name,
      type: group.type,
      health: group.health,
      pods,
      problems: issues,
      members: membersOf.get(group.id) || [],
    });
  }
  return result;
});

let edgeCache = new Map<
  string,
  { from: SceneCard; to: SceneCard; edge: SceneEdge }
>();
const sceneEdges = computed<SceneEdge[]>(() => {
  const groups = topology.value?.groups;
  const cards = sceneCards.value.byId;
  const next = new Map<string, { from: SceneCard; to: SceneCard; edge: SceneEdge }>();
  const result: SceneEdge[] = [];
  for (const edge of visible.value.edges) {
    const from = cards.get(edge.source);
    const to = cards.get(edge.target);
    if (!from || !to) continue;
    let entry = edgeCache.get(edge.id);
    if (!entry || entry.from !== from || entry.to !== to) {
      entry = {
        from,
        to,
        edge: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          // Right side of the source card to the left side of the target.
          sx: from.x + from.width,
          sy: from.y + from.height / 2,
          tx: to.x,
          ty: to.y + to.height / 2,
          missing: from.missing || to.missing,
          crossGroup: from.group !== to.group,
          // Edges into shared / unreferenced groups (a StorageClass used by
          // many apps) stay faint until one of their ends is highlighted.
          faint:
            from.group !== to.group && groups?.get(to.group)?.type !== "app",
          problem:
            from.missing ||
            to.missing ||
            isProblem(from.health) ||
            isProblem(to.health),
        },
      };
    }
    next.set(edge.id, entry);
    result.push(entry.edge);
  }
  edgeCache = next;
  return result;
});

const scene = computed<Scene>(() => ({
  cards: sceneCards.value.index,
  groups: sceneGroups.value,
  lanes: layout.value.lanes,
  edges: sceneEdges.value,
}));

/* --------------------------------------------------------- DOM cards -- */

/*
 * Zoomed in, the cards near the viewport are real (vue-flow) cards: full
 * detail, focusable, expandable. Their node objects are cached, so vue-flow
 * only patches cards whose object or position changed.
 */
const cardWindow = shallowRef<Rect | null>(null);
const NO_CARDS = new Set<string>();
const mountedIds = computed<Set<string>>(() => {
  const area = cardWindow.value;
  if (lod.value !== "cards" || !area) return NO_CARDS;
  const ids = new Set<string>();
  sceneCards.value.index.query(area, (card) => ids.add(card.id));
  return ids;
});

let flowNodeCache = new Map<string, { card: SceneCard; node: Node }>();
const flowNodeOf = (card: SceneCard): Node => {
  const cached = flowNodeCache.get(card.id);
  if (cached && cached.card === card) return cached.node;
  const topoNode = cardCache.get(card.id)!.node;
  const node: Node = {
    id: card.id,
    type: "k8s",
    position: cardCache.get(card.id)!.position,
    width: card.width,
    height: card.height,
    data: { node: markRaw(topoNode) },
    draggable: false,
    connectable: false,
    selectable: false,
    zIndex: 2,
    ariaLabel: `${topoNode.kind} ${topoNode.name}, ${HEALTH_LABEL[topoNode.health]}`,
  };
  flowNodeCache.set(card.id, { card, node });
  return node;
};

/* Objects removed by a live update fade out where they were. */
const leaving = shallowRef<Node[]>([]);

const flowNodes = computed<Node[]>(() => {
  const cards = sceneCards.value.byId;
  const result: Node[] = [];
  const keep = new Map<string, { card: SceneCard; node: Node }>();
  for (const id of mountedIds.value) {
    const card = cards.get(id);
    if (!card) continue;
    result.push(flowNodeOf(card));
    keep.set(id, flowNodeCache.get(id)!);
  }
  flowNodeCache = keep;
  return leaving.value.length ? [...result, ...leaving.value] : result;
});

let flowEdgeCache = new Map<string, { edge: SceneEdge; flow: Edge }>();
const flowEdges = computed<Edge[]>(() => {
  const mounted = mountedIds.value;
  if (mounted.size === 0) return [];
  const result: Edge[] = [];
  const keep = new Map<string, { edge: SceneEdge; flow: Edge }>();
  for (const edge of sceneEdges.value) {
    if (!mounted.has(edge.source) || !mounted.has(edge.target)) continue;
    let entry = flowEdgeCache.get(edge.id);
    if (!entry || entry.edge !== edge) {
      entry = {
        edge,
        flow: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "topology",
          selectable: false,
          focusable: false,
          zIndex: 1,
          data: {
            type: edge.type,
            points: { sx: edge.sx, sy: edge.sy, tx: edge.tx, ty: edge.ty },
            missing: edge.missing,
            crossGroup: edge.crossGroup,
            faint: edge.faint,
            problem: edge.problem,
          },
        },
      };
    }
    keep.set(edge.id, entry);
    result.push(entry.flow);
  }
  flowEdgeCache = keep;
  return result;
});

/* -------------------------------------------------------- highlighting -- */

const lit = computed(() =>
  selected.value && visibleIds.value.has(selected.value)
    ? traceNeighbourhood(adjacency.value, selected.value)
    : null
);

const search = ref("");
const searchInput = ref<InstanceType<typeof Input> | null>(null);
const searchOpen = ref(false);
const searchIndex = ref(0);
/*
 * Search: literal (substring) matches first - instant on thousands of
 * objects - and fuzzy matching (Fuse) only when nothing matches literally.
 * Both indexes are built lazily, on the first search of a model.
 */
const searchList = computed(() =>
  searchEntries(topology.value?.nodes.values() || [])
);
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
  return (
    literalSearch(searchList.value, query) ??
    fuse.value.search(query, { limit: 200 }).map((result) => result.item)
  );
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

/* Groups with a highlighted member stay bright. */
const highlightGroups = computed(() => {
  const ids = lit.value?.nodes ?? matches.value;
  const nodes = topology.value?.nodes;
  if (!ids || !nodes) return null;
  const groups = new Set<string>();
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) groups.add(node.group);
  }
  return groups;
});

const sceneHighlight = computed<SceneHighlight>(() => ({
  selected: selected.value,
  hovered: hovered.value,
  lit: lit.value,
  matches: matches.value,
  problems: problems.value,
  groups: highlightGroups.value,
}));

/*
 * Per-card / per-edge flags for the DOM cards: only the ids whose flags
 * change are touched; dimming the rest is one class (highlightClass).
 */
const flags = new HighlightFlags();
watchEffect(() => {
  const next = new Map<string, number>();
  const add = (id: string, flag: number) =>
    next.set(id, (next.get(id) ?? 0) | flag);
  const { outgoing, incoming } = adjacency.value;
  const edgesOf = (id: string, flag: number) => {
    for (const edge of outgoing.get(id) || []) add(edge.id, flag);
    for (const edge of incoming.get(id) || []) add(edge.id, flag);
  };
  const neighbourhood = lit.value;
  if (neighbourhood) {
    for (const id of neighbourhood.nodes) add(id, FLAG_LIT);
    for (const id of neighbourhood.edges) add(id, FLAG_LIT);
  }
  if (selected.value) add(selected.value, FLAG_SELECTED);
  if (matches.value && !neighbourhood) {
    for (const id of matches.value) {
      add(id, FLAG_MATCH);
      edgesOf(id, FLAG_MATCH);
    }
  }
  if (hovered.value) edgesOf(hovered.value, FLAG_HOVER);
  for (const id of entering.value) add(id, FLAG_ENTER);
  for (const node of leaving.value) add(node.id, FLAG_LEAVE);
  flags.apply(next);
});
const highlightClass = computed(() =>
  lit.value
    ? "graph-flow--lit"
    : matches.value
      ? "graph-flow--search"
      : problems.value
        ? "graph-flow--problems"
        : ""
);

/*
 * Expanding / collapsing re-lays out a group (and the groups after it):
 * the toggled card stays where it is on screen (see the layout watcher).
 */
let anchorId: string | null = null;
const keepInPlace = (id: string, change: () => void) => {
  anchorId = id;
  change();
};

provide(GraphViewStateKey, {
  flags,
  expanded,
  history,
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

/*
 * Level of detail: switched once the zoom settles, so a zoom gesture never
 * swaps hundreds of cards mid-way (the canvas draws whatever is not
 * mounted meanwhile).
 */
const LOD_SETTLE_MS = 160;
let lodTimer: ReturnType<typeof setTimeout> | undefined;
const settleLod = () => {
  lod.value = lodForZoom(viewport.value.zoom, lod.value);
};
watch(
  () => viewport.value.zoom,
  (value) => {
    zoom.value = value;
    clearTimeout(lodTimer);
    if (lodForZoom(value, lod.value) !== lod.value) {
      lodTimer = setTimeout(settleLod, LOD_SETTLE_MS);
    }
  }
);

/*
 * Card window: the viewport plus a margin, snapped to a grid. It follows
 * panning right away (small pans keep the same set), zooming only once the
 * gesture settles.
 */
const WINDOW_GRID = 400;
let windowFrame = 0;
let cardTimer: ReturnType<typeof setTimeout> | undefined;
let cardZoom = 0;
const updateWindow = () => {
  const { width, height } = dimensions.value;
  const { x, y, zoom: scale } = viewport.value;
  if (!width || !height || !scale) return;
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  const margin = Math.max(viewWidth, viewHeight) * 0.25;
  const snap = (value: number, up: boolean) =>
    (up ? Math.ceil(value / WINDOW_GRID) : Math.floor(value / WINDOW_GRID)) *
    WINDOW_GRID;
  const left = snap(-x / scale - margin, false);
  const top = snap(-y / scale - margin, false);
  const right = snap(-x / scale + viewWidth + margin, true);
  const bottom = snap(-y / scale + viewHeight + margin, true);
  const next = { x: left, y: top, width: right - left, height: bottom - top };
  const current = cardWindow.value;
  const same =
    !!current &&
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height;

  clearTimeout(cardTimer);
  if (same) return;
  if (scale === cardZoom || !current) {
    cardWindow.value = next;
    cardZoom = scale;
  } else {
    cardTimer = setTimeout(() => {
      cardZoom = viewport.value.zoom;
      updateWindow();
    }, LOD_SETTLE_MS);
  }
};
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
/*
 * A gesture or animation ended: switch the level of detail and mount the
 * cards of the final viewport right away (no settle delay).
 */
const onMoveEnd = () => {
  moving.value = false;
  clearTimeout(lodTimer);
  settleLod();
  cardZoom = viewport.value.zoom;
  cancelAnimationFrame(windowFrame);
  updateWindow();
};

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
      const card = sceneCards.value.byId.get(id);
      if (card) add(card);
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
    height / (bounds.height * 1.16),
    1
  );
  if (fitZoom >= MIN_READABLE_ZOOM) fitAll(0);
  else setViewport({ x: 24, y: 16, zoom: 0.75 });
  lod.value = lodForZoom(fitZoom >= MIN_READABLE_ZOOM ? fitZoom : 0.75);
};

const showGraph = computed(
  () => !loadError.value && !loading.value && !!topology.value
);

/* Once per scope, as soon as the graph and the canvas size are known. */
const viewedScope = ref("");
watch(
  [showGraph, () => dimensions.value.width, layout],
  () => {
    if (!showGraph.value || !dimensions.value.width) return;
    const key = JSON.stringify(scope.value);
    if (viewedScope.value === key || layout.value.groups.size === 0) return;
    viewedScope.value = key;
    nextTick(initialView);
  }
);

/* Render time of the last change (for the timings). */
const renderMs = ref(0);
let layoutDone = 0;
watch(layout, () => (layoutDone = performance.now()));
const onNodesInitialized = () => {
  renderMs.value = performance.now() - layoutDone;
};

/*
 * Keep the viewport stable when the layout changes (live updates,
 * expanding a workload): the anchor - the toggled card, the selection or
 * the card nearest the centre of the view - stays where it is on screen.
 */
watch(layout, (next, previous) => {
  const requested = anchorId;
  anchorId = null;
  if (!previous || next === previous || next.nodes.size === 0) return;
  const { x, y, zoom: scale } = viewport.value;
  const { width, height } = dimensions.value;
  let anchor: string | null = null;
  for (const id of [requested, selected.value]) {
    if (id && previous.nodes.has(id) && next.nodes.has(id)) {
      anchor = id;
      break;
    }
  }
  if (!anchor && scale && width) {
    const cx = (width / 2 - x) / scale;
    const cy = (height / 2 - y) / scale;
    let best = Infinity;
    for (const [id, position] of previous.nodes) {
      if (!next.nodes.has(id)) continue;
      const distance = Math.hypot(position.x - cx, position.y - cy);
      if (distance < best) {
        best = distance;
        anchor = id;
      }
    }
  }
  if (!anchor) return;
  const before = previous.nodes.get(anchor)!;
  const after = next.nodes.get(anchor)!;
  if (before.x === after.x && before.y === after.y) return;
  setViewport({
    x: x - (after.x - before.x) * scale,
    y: y - (after.y - before.y) * scale,
    zoom: scale,
  });
});

const focusNodes = (ids: string[], maxZoom = 1.1) => {
  if (ids.length === 0) return;
  fitRect(boundsOf(ids), { padding: 0.15, maxZoom, duration: 400 });
};

/** Centre a card (zoomed in to a readable level unless `keepZoom`). */
const centerOn = (id: string, keepZoom = false) => {
  const card = sceneCards.value.byId.get(id);
  if (!card) return;
  const scale = viewport.value.zoom;
  setCenter(card.x + card.width / 2, card.y + card.height / 2, {
    zoom: keepZoom ? scale : Math.max(scale, 0.9),
    duration: 350,
  });
};

/* --------------------------------------------------------- selection -- */

const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);
const { sidePanel } = injectStrict(PanelProviderStateKey);

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
      onSelect: (id: string) => select(id, { reveal: "center" }),
      onFocus: () => focusSelection(),
    },
  });
};

/** Pan to a node when it is (partly) off screen (e.g. behind the panel). */
const ensureVisible = (id: string) => {
  const card = sceneCards.value.byId.get(id);
  if (!card) return;
  const { x, y, zoom: scale } = viewport.value;
  const left = card.x * scale + x;
  const top = card.y * scale + y;
  const margin = 24;
  if (
    left < margin ||
    top < margin ||
    left + card.width * scale > dimensions.value.width - margin ||
    top + card.height * scale > dimensions.value.height - margin
  ) {
    centerOn(id, true);
  }
};

/*
 * A click opens the side panel a moment later: the panel narrows the
 * canvas, and the second click of a double-click must still land on the
 * node (not on the panel that slid in under the pointer).
 */
let panelTimer: ReturnType<typeof setTimeout> | undefined;
let panelFrame = 0;
/* Without a delay: right after the highlight is painted. */
const schedulePanel = (open: () => void, delay: number) => {
  clearTimeout(panelTimer);
  cancelAnimationFrame(panelFrame);
  if (delay > 0) panelTimer = setTimeout(open, delay);
  else {
    panelFrame = requestAnimationFrame(() => {
      panelTimer = setTimeout(open, 0);
    });
  }
};
const cancelPanel = () => {
  clearTimeout(panelTimer);
  cancelAnimationFrame(panelFrame);
};

/**
 * Select an object (expanding its workload when it is collapsed). The
 * highlight is immediate; `reveal` brings it into view right away, the side
 * panel follows after `panelDelay`.
 */
const select = (
  id: string,
  options: { reveal?: "center" | "ensure"; panelDelay?: number } = {}
) => {
  const node = topology.value?.nodes.get(id);
  if (!node) return;
  if (node.parent && !expanded.value.has(node.parent)) {
    anchorId = node.parent;
    toggleIn(expanded, node.parent);
  }
  if (node.old && node.parent && !history.value.has(node.parent)) {
    toggleIn(history, node.parent);
  }
  selected.value = id;
  if (options.reveal) {
    // After an expansion is laid out.
    nextTick(() => {
      if (selected.value !== id) return;
      if (options.reveal === "center") centerOn(id);
      else ensureVisible(id);
    });
  }
  schedulePanel(() => {
    if (selected.value !== id) return;
    openDetails(node);
    // Once the panel narrowed the canvas.
    setTimeout(() => {
      if (selected.value === id) ensureVisible(id);
    }, 220);
  }, options.panelDelay ?? 0);
};

const focusSelection = () => {
  if (lit.value) focusNodes([...lit.value.nodes]);
};

const clearSelection = () => {
  cancelPanel();
  if (selected.value === null) return;
  selected.value = null;
  setSidePanelComponent(null);
};

/* Closing the side panel ends the selection. */
watch(sidePanel, (panel) => {
  if (!panel && selected.value) selected.value = null;
});

const clickCard = (id: string) => {
  if (selected.value !== id) select(id, { panelDelay: 260 });
};
const doubleClickCard = (id: string) => {
  cancelPanel();
  const topoNode = topology.value?.nodes.get(id);
  selected.value = id;
  if (topoNode) openDetails(topoNode);
  // Fit the neighbourhood into the canvas the panel left.
  setTimeout(
    () => focusNodes([...traceNeighbourhood(adjacency.value, id).nodes]),
    240
  );
};

const onNodeClick = ({ node }: NodeMouseEvent) => {
  if (node.type !== "k8s" || node.id.startsWith("ghost:")) return;
  clickCard(node.id);
};
const onNodeDoubleClick = ({ node }: NodeMouseEvent) => {
  if (node.type !== "k8s" || node.id.startsWith("ghost:")) return;
  doubleClickCard(node.id);
};

/*
 * Cards drawn on the canvas (zoomed out / not mounted) are hit-tested on
 * the pane: same click, double-click and hover as the DOM cards.
 */
const { vueFlowRef } = useVueFlow();
const isPane = (event: Event) =>
  (event.target as Element | null)?.classList?.contains("vue-flow__pane") ??
  false;
const canvasCardAt = (event: MouseEvent): SceneCard | null => {
  const element = vueFlowRef.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const { x, y, zoom: scale } = viewport.value;
  const card = sceneCards.value.index.at(
    (event.clientX - rect.left - x) / scale,
    (event.clientY - rect.top - y) / scale
  );
  return card && !mountedIds.value.has(card.id) ? card : null;
};
const onPaneClick = (event: MouseEvent) => {
  const card = canvasCardAt(event);
  if (card) clickCard(card.id);
  else clearSelection();
};
const onPaneDoubleClick = (event: MouseEvent) => {
  if (!isPane(event)) return;
  const card = canvasCardAt(event);
  if (card) doubleClickCard(card.id);
};
const pointerOnCard = ref(false);
let hoverFrame = 0;
const onPaneMouseMove = (event: MouseEvent) => {
  if (!isPane(event)) return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const card = moving.value ? null : canvasCardAt(event);
    pointerOnCard.value = !!card;
    if ((card?.id ?? null) === hoverSource) return;
    if (card) showTooltip(card.id, event);
    else if (hoverSource !== null) hideTooltip();
  });
};
const onPaneMouseLeave = () => {
  cancelAnimationFrame(hoverFrame);
  pointerOnCard.value = false;
  if (hoverSource !== null) hideTooltip();
};

/*
 * Live updates: the selection (and its panel) follows the object - the
 * panel only refreshes when the selected object or the relationships
 * changed (unchanged nodes and edges keep their identity); new cards fade
 * in, removed ones fade out.
 */
watch(topology, (next, previous) => {
  if (!selected.value) return;
  const node = next?.nodes.get(selected.value);
  if (!node) {
    clearSelection();
    return;
  }
  if (
    node !== previous?.nodes.get(selected.value) ||
    next!.edges !== previous?.edges
  ) {
    openDetails(node);
  }
});

/* The DOM cards of the last render (ghosts of removed objects). */
let renderedCards = new Map<string, Node>();
watch(
  flowNodes,
  (nodes) => (renderedCards = new Map(nodes.map((node) => [node.id, node]))),
  { flush: "post" }
);

let enteringTimer: ReturnType<typeof setTimeout> | undefined;
let leavingTimer: ReturnType<typeof setTimeout> | undefined;
watch(change, (next) => {
  if (!next || !next.structure || next.initial) return;
  if (next.added.size > 0) {
    entering.value = next.added;
    clearTimeout(enteringTimer);
    enteringTimer = setTimeout(() => (entering.value = new Set()), 1200);
  }
  // Removed objects that were on screen: a ghost fades out in place.
  const ghosts: Node[] = [];
  for (const id of next.removed) {
    const card = renderedCards.get(id);
    if (!card) continue;
    ghosts.push({
      ...card,
      id: `ghost:${id}`,
      focusable: false,
      zIndex: 1,
    });
  }
  if (ghosts.length > 0) {
    leaving.value = [...leaving.value, ...ghosts];
    clearTimeout(leavingTimer);
    leavingTimer = setTimeout(() => (leaving.value = []), 450);
  }
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
    flags.clear();
    leaving.value = [];
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
  setTimeout(() => (problems.value ? fitAll() : initialView()), 150);
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
/** Card the pointer is on (DOM or canvas). */
let hoverSource: string | null = null;

const showTooltip = (id: string, event: MouseEvent) => {
  hoverSource = id;
  hovered.value = id;
  const topoNode = topology.value?.nodes.get(id);
  const rect = canvas.value?.getBoundingClientRect();
  clearTimeout(tooltipTimer);
  tooltip.value = null;
  if (!topoNode || !rect) return;
  const { clientX, clientY } = event;
  tooltipTimer = setTimeout(() => {
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    tooltip.value = {
      node: topoNode,
      x: x > rect.width - 300 ? x - 296 : x + 16,
      y: Math.min(y + 16, rect.height - 180),
    };
  }, 350);
};
const hideTooltip = () => {
  hoverSource = null;
  hovered.value = null;
  clearTimeout(tooltipTimer);
  tooltip.value = null;
};
const onNodeMouseEnter = ({ node, event }: NodeMouseEvent) => {
  if (node.type !== "k8s" || node.id.startsWith("ghost:")) return;
  showTooltip(node.id, event as MouseEvent);
};
const onNodeMouseLeave = () => hideTooltip();

/* Node placement: the node of a pod, the spread of a workload's pods. */
const tooltipPlacement = computed(() => {
  const node = tooltip.value?.node;
  if (!node) return "";
  if (node.kind === "Pod") {
    const host = node.object?.spec?.nodeName;
    return host ? `on ${host}` : "not scheduled";
  }
  const pods = node.pods || [];
  if (pods.length === 0) return "";
  const hosts = new Set(
    pods.map((pod) => pod.spec?.nodeName).filter(Boolean) as string[]
  );
  const pending = pods.filter((pod) => !pod.spec?.nodeName).length;
  return `${pods.length} pod${pods.length === 1 ? "" : "s"} on ${hosts.size} node${hosts.size === 1 ? "" : "s"}${pending ? ` · ${pending} unscheduled` : ""}`;
});
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
  select(node.id, { reveal: "center" });
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

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/*
 * Arrow keys move the selection to the nearest card in that direction
 * (from the card nearest the centre when nothing is selected). The panel
 * follows once the keys rest.
 */
const navigate = (direction: Direction) => {
  const cards = sceneCards.value;
  let from = selected.value ? cards.byId.get(selected.value) : undefined;
  if (!from) {
    const { x, y, zoom: scale } = viewport.value;
    const { width, height } = dimensions.value;
    const center = { x: (width / 2 - x) / scale, y: (height / 2 - y) / scale, width: 0, height: 0 };
    let best = Infinity;
    for (const card of cards.list) {
      const distance = Math.hypot(
        card.x + card.width / 2 - center.x,
        card.y + card.height / 2 - center.y
      );
      if (distance < best) {
        best = distance;
        from = card;
      }
    }
    if (from) select(from.id, { reveal: "ensure", panelDelay: 400 });
    return;
  }
  const next = nearestInDirection(from, cards.list, direction, from.id);
  if (!next) return;
  select(next.id, { reveal: "ensure", panelDelay: 400 });
  nextTick(() =>
    (
      canvas.value?.querySelector(
        `.vue-flow__node[data-id="${CSS.escape(next.id)}"]`
      ) as HTMLElement | null
    )?.focus({ preventScroll: true })
  );
};

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
  // Keys in the side panel / toolbar belong to them.
  const target = event.target as HTMLElement | null;
  const inGraph =
    !target || target === document.body || !!canvas.value.contains(target);
  const card = target?.closest?.(".vue-flow__node-k8s");
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    const id = card.getAttribute("data-id");
    if (id && !id.startsWith("ghost:")) select(id);
    return;
  }
  if (ARROWS[event.key] && inGraph && showGraph.value) {
    event.preventDefault();
    navigate(ARROWS[event.key]);
  } else if (event.key === "/") {
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
  clearTimeout(leavingTimer);
  cancelPanel();
  clearTimeout(cardTimer);
  clearTimeout(lodTimer);
  cancelAnimationFrame(windowFrame);
  cancelAnimationFrame(hoverFrame);
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
/* Watched data is live; polled data is as fresh as its last poll. */
const statusLabel = computed(() =>
  paused.value
    ? "Paused"
    : sourceMode.value === "poll"
      ? updatedLabel.value
      : "Live"
);
const statusTitle = computed(() => {
  if (paused.value) return "Live updates paused";
  const every = `${GRAPH_REFRESH_INTERVAL / 1000} s`;
  if (sourceMode.value === "watch") return "Live: watching the cluster";
  if (sourceMode.value === "mixed") {
    return `Live (some kinds are polled with kubectl every ${every})`;
  }
  return `Polling with kubectl every ${every} · ${updatedLabel.value}`;
});

/* Timings for the performance harness (and the curious). */
watchEffect(() => {
  if (!timings.value) return;
  (window as any).__graphTimings = {
    ...timings.value,
    layoutMs: lastLayoutMs,
    layouts: layoutRuns,
    renderMs: renderMs.value,
    lod: lod.value,
    cards: flowNodes.value.length,
    edges: flowEdges.value.length,
    groups: visible.value.groups.length,
  };
});

/* Minimap: every group (not only the rendered ones) and the visible area. */
const minimapGroups = computed(() =>
  sceneGroups.value.map((group) => ({
    id: group.id,
    rect: group as Rect,
    health: group.health,
    app: group.type === "app",
  }))
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
            <Check
              v-if="name === graphContext"
              class="ml-auto h-3.5 w-3.5 text-link"
            />
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
          :title="statusTitle"
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
          <span v-if="!narrow">{{ statusLabel }}</span>
          <span v-else class="sr-only">{{ statusLabel }}</span>
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
    <div
      ref="canvas"
      class="relative min-h-0 flex-1"
      @dblclick="onPaneDoubleClick"
      @mousemove="onPaneMouseMove"
      @mouseleave="onPaneMouseLeave"
    >
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

        <GraphCanvas
          v-if="showGraph"
          :scene="scene"
          :viewport="viewport"
          :lod="lod"
          :mounted="mountedIds"
          :highlight="sceneHighlight"
        />
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
            highlightClass,
            moving && 'graph-flow--moving',
            pointerOnCard && 'graph-flow--pointer',
          ]"
          @node-click="onNodeClick"
          @node-double-click="onNodeDoubleClick"
          @node-mouse-enter="onNodeMouseEnter"
          @node-mouse-leave="onNodeMouseLeave"
          @pane-click="onPaneClick"
          @nodes-initialized="onNodesInitialized"
          @move-start="moving = true"
          @move-end="onMoveEnd"
        >
          <template #node-k8s="props">
            <ObjectNode v-bind="props" />
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
          <div
            v-if="tooltipPlacement"
            class="mt-1 truncate text-muted-foreground"
            :title="tooltipPlacement"
          >
            {{ tooltipPlacement }}
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
.cluster-graph .vue-flow__node-k8s {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: inherit;
  cursor: pointer;
  /* Cards have a fixed size: keep their layout and paint to themselves. */
  contain: layout style;
}
.cluster-graph .vue-flow__node:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
  border-radius: var(--radius);
}
/* The pane is under the pointer on canvas-drawn cards. */
.cluster-graph .graph-flow--pointer .vue-flow__pane {
  cursor: pointer;
}

/* Cards: highlight states (flags) and dimming (one class on the canvas). */
.graph-card {
  contain: layout paint style;
}
.graph-card:not(.is-selected):not(.is-lit):not(.is-match):hover {
  border-color: hsl(var(--border-strong));
}
.graph-card.is-selected {
  border-color: hsl(var(--primary));
  outline: 2px solid hsl(var(--primary) / 0.3);
  outline-offset: 1px;
}
.graph-card.is-lit:not(.is-selected) {
  border-color: hsl(var(--primary) / 0.6);
}
.graph-flow--search .graph-card.is-match {
  border-color: hsl(var(--link));
  outline: 2px solid hsl(var(--link) / 0.25);
  outline-offset: 1px;
}
.graph-flow--lit .graph-card:not(.is-lit),
.graph-flow--search .graph-card:not(.is-match) {
  opacity: 0.22;
}
.graph-flow--problems .graph-card:not(.is-problem) {
  opacity: 0.5;
}

/* Edges: one style per relationship type. */
.graph-edge {
  stroke: hsl(var(--muted-foreground) / 0.45);
  stroke-width: 1.4;
  fill: none;
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
.graph-edge--faint {
  opacity: 0.12;
}
.graph-edge.is-lit,
.graph-edge.is-hover {
  stroke-width: 2.2;
  opacity: 1;
}
.graph-edge-end.is-lit,
.graph-edge-end.is-hover {
  opacity: 1;
}
.graph-edge.is-lit.graph-edge--owns,
.graph-edge.is-lit.graph-edge--mounts,
.graph-edge.is-lit.graph-edge--selects,
.graph-edge.is-hover.graph-edge--owns,
.graph-edge.is-hover.graph-edge--mounts,
.graph-edge.is-hover.graph-edge--selects {
  stroke: hsl(var(--primary) / 0.85);
}
.graph-flow--lit :is(.graph-edge, .graph-edge-end):not(.is-lit):not(.is-hover),
.graph-flow--search :is(.graph-edge, .graph-edge-end):not(.is-match):not(.is-hover),
.graph-flow--problems :is(.graph-edge, .graph-edge-end):not(.graph-edge--problem):not(.is-hover) {
  opacity: 0.1;
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
.graph-card--leave {
  animation: graph-leave 420ms ease-in forwards;
  pointer-events: none;
}
@keyframes graph-enter {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
@keyframes graph-leave {
  to {
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
  .graph-card--leave {
    animation: none;
    opacity: 0;
  }
}
</style>
