/**
 * Canvas renderer of the resource graph: namespace lanes and application
 * groups at every zoom level, and - zoomed out, or where no card is mounted
 * - the cards and edges themselves. One canvas, culled to the viewport, so
 * zooming and panning cost the same for 20 or 2,000 objects; the DOM only
 * holds the detailed cards near the viewport (see ClusterOverview.vue).
 *
 * Everything is drawn in graph coordinates (the canvas transform applies
 * the viewport), sizes match the DOM cards and groups.
 */
import type {
  AppGroup,
  EdgeType,
  Health,
  NodeCategory,
} from "./clusterGraph";
import { CLUSTER_NAMESPACE, PLACEMENT_LANE } from "./clusterGraph";
import type { Rect } from "./clusterGraphLayout";
import { GROUP_HEADER, LANE_HEADER } from "./clusterGraphLayout";
import type { GraphLod, SpatialIndex } from "./clusterGraphView";

/* ---------------------------------------------------------------- scene -- */

export interface SceneCard extends Rect {
  id: string;
  name: string;
  /** Kind label + summary ("Deployment · 2/3 ready"). */
  subtitle: string;
  health: Health;
  category: NodeCategory;
  missing: boolean;
  external: boolean;
  /** Pods are smaller cards. */
  compact: boolean;
  group: string;
}

export interface SceneGroup extends Rect {
  id: string;
  title: string;
  type: AppGroup["type"];
  health: Health;
  pods: number;
  problems: number;
  /** Member cards (overview blocks). */
  members: SceneCard[];
}

export interface SceneLane {
  namespace: string;
  x: number;
  y: number;
  width: number;
  apps: number;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  missing: boolean;
  crossGroup: boolean;
  faint: boolean;
  problem: boolean;
}

export interface Scene {
  cards: SpatialIndex<SceneCard>;
  groups: SceneGroup[];
  lanes: SceneLane[];
  edges: SceneEdge[];
}

/** Highlight state, as the DOM cards see it. */
export interface SceneHighlight {
  selected: string | null;
  hovered: string | null;
  lit: { nodes: Set<string>; edges: Set<string> } | null;
  matches: Set<string> | null;
  problems: boolean;
  /** Groups with a lit / matching member. */
  groups: Set<string> | null;
}

export interface SceneView {
  /** Viewport translation (screen px) and scale. */
  x: number;
  y: number;
  zoom: number;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  dpr: number;
}

/* -------------------------------------------------------------- palette -- */

const TOKENS = [
  "background",
  "foreground",
  "card",
  "surface-1",
  "muted",
  "muted-foreground",
  "border",
  "border-strong",
  "border-subtle",
  "primary",
  "link",
  "info",
  "success",
  "warning",
  "destructive",
] as const;
type Token = (typeof TOKENS)[number];

export type GraphPalette = Record<Token, string>;

/** Design tokens ("H S% L%") of the element's theme. */
export function readPalette(element: Element): GraphPalette {
  const style = getComputedStyle(element);
  const palette = {} as GraphPalette;
  for (const token of TOKENS) {
    palette[token] = style.getPropertyValue(`--${token}`).trim() || "0 0% 50%";
  }
  return palette;
}

const colorCache = new Map<string, string>();
const hsl = (triplet: string, alpha = 1) => {
  const key = `${triplet}/${alpha}`;
  let color = colorCache.get(key);
  if (!color) {
    color = `hsl(${triplet} / ${alpha})`;
    colorCache.set(key, color);
  }
  return color;
};

const FONT = '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
const font = (weight: number, size: number) => `${weight} ${size}px ${FONT}`;

/* ------------------------------------------------------------- helpers -- */

const HEALTH_DOT: Record<Health, Token> = {
  ok: "success",
  neutral: "success",
  warning: "warning",
  error: "destructive",
};

const TILE: Record<NodeCategory, [Token, number]> = {
  traffic: ["info", 0.1],
  service: ["info", 0.1],
  workload: ["primary", 0.1],
  replicaset: ["primary", 0.1],
  job: ["primary", 0.1],
  pod: ["primary", 0.1],
  config: ["muted", 1],
  storage: ["muted", 1],
  identity: ["muted", 1],
  policy: ["muted", 1],
};

/* Edge styles, as .graph-edge--* in ClusterOverview.vue. */
const EDGE: Record<EdgeType, { color: Token; alpha: number; width: number; dash: number[] }> = {
  owns: { color: "muted-foreground", alpha: 0.4, width: 1.4, dash: [] },
  routes: { color: "info", alpha: 0.75, width: 1.6, dash: [6, 4] },
  selects: { color: "muted-foreground", alpha: 0.5, width: 1.4, dash: [1.5, 3.5] },
  mounts: { color: "muted-foreground", alpha: 0.38, width: 1.4, dash: [4, 3] },
  scales: { color: "primary", alpha: 0.65, width: 1.4, dash: [8, 3, 2, 3] },
};

const LAYERS_ICON = [
  "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
  "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
  "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
];
const FOLDER_TREE_ICON = [
  "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
  "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
  "M3 5a2 2 0 0 0 2 2h3",
  "M3 3v13a2 2 0 0 0 2 2h3",
];
const GLOBE_ICON = [
  "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20",
  "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
  "M2 12h20",
];
const SERVER_ICON = [
  "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z",
  "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z",
  "M6 6h.01",
  "M6 18h.01",
];
let iconCache: Map<string[], Path2D[]> | null = null;
const iconPaths = (icon: string[]) => {
  iconCache ??= new Map();
  let paths = iconCache.get(icon);
  if (!paths) {
    paths = icon.map((d) => new Path2D(d));
    iconCache.set(icon, paths);
  }
  return paths;
};
function drawIcon(
  ctx: CanvasRenderingContext2D,
  icon: string[],
  x: number,
  y: number,
  size: number,
  color: string
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of iconPaths(icon)) ctx.stroke(path);
  ctx.restore();
}

/* Text widths are cached per font: names do not change while zooming. */
const widthCache = new Map<string, number>();
function textWidth(ctx: CanvasRenderingContext2D, text: string, fontSpec: string) {
  const key = `${fontSpec}\u0000${text}`;
  let width = widthCache.get(key);
  if (width === undefined) {
    ctx.font = fontSpec;
    width = ctx.measureText(text).width;
    if (widthCache.size > 20_000) widthCache.clear();
    widthCache.set(key, width);
  }
  return width;
}

/** Text clipped with an ellipsis to `max` (graph units). */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSpec: string,
  max: number
): string {
  if (max <= 0) return "";
  if (textWidth(ctx, text, fontSpec) <= max) return text;
  const key = `${fontSpec}\u0001${text}\u0001${Math.round(max)}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(ctx, `${text.slice(0, mid)}…`, fontSpec) <= max) low = mid;
    else high = mid - 1;
  }
  const result = low > 0 ? `${text.slice(0, low)}…` : "";
  if (fitCache.size > 20_000) fitCache.clear();
  fitCache.set(key, result);
  return result;
}
const fitCache = new Map<string, string>();

/** Forget measured text (e.g. once the app font has loaded). */
export function clearTextCache() {
  widthCache.clear();
  fitCache.clear();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  addRoundRect(ctx, x, y, width, height, radius);
}

/** Adds a rounded rectangle to the current path. */
function addRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  // Older WebKit: no roundRect.
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Bezier control offset, as vue-flow's getBezierPath (curvature 0.35). */
const controlOffset = (distance: number) =>
  distance >= 0 ? 0.5 * distance : 0.35 * 25 * Math.sqrt(-distance);

/* ---------------------------------------------------------------- dims -- */

export const DIM_ALPHA = 0.22;
export const PROBLEMS_DIM_ALPHA = 0.5;

const isProblemHealth = (health: Health) =>
  health === "warning" || health === "error";

/** Opacity of a card under the current highlight (1 = normal). */
export function cardAlpha(card: SceneCard, highlight: SceneHighlight): number {
  if (highlight.lit) return highlight.lit.nodes.has(card.id) ? 1 : DIM_ALPHA;
  if (highlight.matches) return highlight.matches.has(card.id) ? 1 : DIM_ALPHA;
  if (highlight.problems) {
    return isProblemHealth(card.health) || card.missing ? 1 : PROBLEMS_DIM_ALPHA;
  }
  return 1;
}

export function groupDimmed(group: SceneGroup, highlight: SceneHighlight): boolean {
  if (highlight.groups) return !highlight.groups.has(group.id);
  if (highlight.problems) return !isProblemHealth(group.health);
  return false;
}

/* ---------------------------------------------------------------- draw -- */

export interface DrawOptions {
  lod: GraphLod;
  /** Cards (and edges between them) rendered by the DOM: not drawn. */
  mounted: Set<string>;
}

/** The visible graph area of a view (graph coordinates). */
export function viewRect(view: SceneView): Rect {
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    width: view.width / view.zoom,
    height: view.height / view.zoom,
  };
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: SceneView,
  palette: GraphPalette,
  highlight: SceneHighlight,
  options: DrawOptions
) {
  const { zoom, dpr } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width * dpr, view.height * dpr);
  if (!zoom) return;
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * view.x, dpr * view.y);
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  const area = viewRect(view);
  // Cards are culled with a margin for their borders / rings.
  const margin = 8 / zoom;
  const culled = {
    x: area.x - margin,
    y: area.y - margin,
    width: area.width + margin * 2,
    height: area.height + margin * 2,
  };
  const overview = options.lod === "overview";
  const simple = options.lod === "simple";

  /* Lanes: namespace titles (hidden in the overview). */
  if (!overview) {
    for (const lane of scene.lanes) {
      if (!intersects(culled, { x: lane.x, y: lane.y, width: Math.max(lane.width, 200), height: LANE_HEADER })) {
        continue;
      }
      drawLane(ctx, lane, palette, simple, zoom);
    }
  }

  /* Groups. */
  for (const group of scene.groups) {
    if (!intersects(culled, group)) continue;
    drawGroup(ctx, group, palette, highlight, zoom, overview, simple);
  }
  if (overview) {
    drawBlocks(ctx, scene, culled, palette, highlight, zoom);
    for (const group of scene.groups) {
      if (!intersects(culled, group)) continue;
      drawOverviewTitle(ctx, group, palette, highlight, zoom);
    }
    return;
  }

  /* Edges of cards drawn here (both ends mounted = a DOM edge). */
  const mounted = options.mounted;
  for (const edge of scene.edges) {
    if (mounted.has(edge.source) && mounted.has(edge.target)) continue;
    const left = Math.min(edge.sx, edge.tx);
    const top = Math.min(edge.sy, edge.ty);
    if (
      !intersects(culled, {
        x: left - 40,
        y: top - 4,
        width: Math.abs(edge.tx - edge.sx) + 80,
        height: Math.abs(edge.ty - edge.sy) + 8,
      })
    ) {
      continue;
    }
    drawEdge(ctx, edge, palette, highlight, zoom);
  }
  ctx.setLineDash([]);

  /* Cards not mounted in the DOM. */
  scene.cards.query(culled, (card) => {
    if (mounted.has(card.id)) return;
    drawCard(ctx, card, palette, highlight, zoom, simple);
  });
  ctx.globalAlpha = 1;
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  lane: SceneLane,
  palette: GraphPalette,
  simple: boolean,
  zoom: number
) {
  const color = hsl(palette["muted-foreground"]);
  const middle = lane.y + (LANE_HEADER - 6) / 2;
  const cluster = lane.namespace === CLUSTER_NAMESPACE;
  const placement = lane.namespace === PLACEMENT_LANE;
  drawIcon(
    ctx,
    cluster ? GLOBE_ICON : placement ? SERVER_ICON : FOLDER_TREE_ICON,
    lane.x,
    middle - 7,
    14,
    color
  );
  const size = simple ? Math.min(28, Math.max(20, 10 / zoom)) : 11;
  const titleFont = font(600, size);
  const title = (
    cluster ? "Cluster" : placement ? "Nodes" : lane.namespace
  ).toUpperCase();
  ctx.font = titleFont;
  ctx.fillStyle = color;
  ctx.letterSpacing = `${size * 0.05}px`;
  ctx.fillText(title, lane.x + 22, middle);
  ctx.letterSpacing = "0px";
  if (lane.apps > 0) {
    const x = lane.x + 22 + textWidth(ctx, title, titleFont) + size * 0.05 * title.length + 6;
    ctx.font = font(400, size);
    const unit = placement ? "node" : "app";
    ctx.fillText(`· ${lane.apps} ${unit}${lane.apps === 1 ? "" : "s"}`, x, middle);
  }
}

function drawGroup(
  ctx: CanvasRenderingContext2D,
  group: SceneGroup,
  palette: GraphPalette,
  highlight: SceneHighlight,
  zoom: number,
  overview: boolean,
  simple: boolean
) {
  const app = group.type === "app";
  ctx.globalAlpha = groupDimmed(group, highlight) ? 0.4 : 1;

  roundRect(ctx, group.x, group.y, group.width, group.height, 12);
  ctx.fillStyle = hsl(palette["surface-1"], app ? 0.7 : 0.3);
  ctx.fill();
  if (!app) ctx.setLineDash([4, 3]);
  ctx.strokeStyle = hsl(palette.border);
  ctx.lineWidth = Math.max(1, 0.75 / zoom);
  ctx.stroke();
  ctx.setLineDash([]);

  if (group.health === "error" || group.health === "warning") {
    ctx.save();
    roundRect(ctx, group.x, group.y, group.width, group.height, 12);
    ctx.clip();
    ctx.fillStyle = hsl(palette[group.health === "error" ? "destructive" : "warning"], 0.85);
    ctx.fillRect(group.x, group.y, group.width, Math.max(2, 1.5 / zoom));
    ctx.restore();
  }

  if (overview) {
    ctx.globalAlpha = 1;
    return;
  }

  /* Header: health dot / layers icon, title, issues and pods. */
  const middle = group.y + GROUP_HEADER / 2;
  let x = group.x + 14;
  if (app) {
    ctx.fillStyle = hsl(palette[HEALTH_DOT[group.health]]);
    ctx.beginPath();
    ctx.arc(x + 4, middle, 4, 0, Math.PI * 2);
    ctx.fill();
    x += 16;
  } else {
    drawIcon(ctx, LAYERS_ICON, x, middle - 7, 14, hsl(palette["muted-foreground"]));
    x += 22;
  }
  const metaFont = font(400, 11);
  const meta: { text: string; color: string }[] = [];
  if (group.problems > 0) {
    meta.push({
      text: `${group.problems} issue${group.problems === 1 ? "" : "s"}`,
      color: hsl(palette[group.health === "error" ? "destructive" : "warning"]),
    });
  }
  if (group.pods > 0) {
    meta.push({
      text: `${group.pods} pod${group.pods === 1 ? "" : "s"}`,
      color: hsl(palette["muted-foreground"]),
    });
  }
  let right = group.x + group.width - 14;
  if (!simple) {
    ctx.font = metaFont;
    ctx.textAlign = "right";
    for (const item of [...meta].reverse()) {
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, right, middle);
      right -= textWidth(ctx, item.text, metaFont) + 8;
    }
    ctx.textAlign = "left";
  }
  const titleFont = font(
    app ? 600 : 500,
    simple ? Math.min(36, Math.max(22, 11 / zoom)) : 13
  );
  ctx.font = titleFont;
  ctx.fillStyle = hsl(palette[app ? "foreground" : "muted-foreground"]);
  ctx.fillText(fitText(ctx, group.title, titleFont, right - x - 8), x, middle);
  ctx.globalAlpha = 1;
}

/*
 * Overview: every member card as a block in its health colour, batched
 * per colour (one fill and one stroke for hundreds of blocks).
 */
function drawBlocks(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  area: Rect,
  palette: GraphPalette,
  highlight: SceneHighlight,
  zoom: number
) {
  const batches = new Map<string, SceneCard[]>();
  for (const group of scene.groups) {
    if (!intersects(area, group)) continue;
    const dimmed = groupDimmed(group, highlight);
    for (const card of group.members) {
      const key = `${card.missing ? "error" : card.health}|${dimmed ? 1 : 0}`;
      const list = batches.get(key);
      if (list) list.push(card);
      else batches.set(key, [card]);
    }
  }
  ctx.lineWidth = Math.max(1, 0.75 / zoom);
  for (const [key, cards] of batches) {
    const [health, dimmed] = key.split("|");
    const [border, fill]: [string, string] =
      health === "ok"
        ? [hsl(palette.success, 0.4), hsl(palette.success, 0.2)]
        : health === "warning"
          ? [hsl(palette.warning, 0.6), hsl(palette.warning, 0.35)]
          : health === "error"
            ? [hsl(palette.destructive, 0.7), hsl(palette.destructive, 0.45)]
            : [hsl(palette["border-strong"]), hsl(palette.muted)];
    ctx.globalAlpha = dimmed === "1" ? 0.4 : 1;
    ctx.beginPath();
    for (const card of cards) {
      addRoundRect(ctx, card.x, card.y, card.width, card.height, 8);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawOverviewTitle(
  ctx: CanvasRenderingContext2D,
  group: SceneGroup,
  palette: GraphPalette,
  highlight: SceneHighlight,
  zoom: number
) {
  /* A pill with a constant on-screen size (13px). */
  const size = 13 / zoom;
  const titleFont = font(600, size);
  const pad = size * 0.4;
  const dot = size * 0.55;
  const maxWidth = group.width - 16 / zoom - pad * 2 - dot - size * 0.35;
  const title = fitText(ctx, group.title, titleFont, maxWidth);
  if (!title) return;
  const width = textWidth(ctx, title, titleFont) + pad * 2 + dot + size * 0.35;
  const height = size * 1.4;
  const x = group.x + (group.width - width) / 2;
  const y = group.y + (group.height - height) / 2;
  ctx.globalAlpha = groupDimmed(group, highlight) ? 0.4 : 1;
  roundRect(ctx, x, y, width, height, 6 / zoom);
  ctx.fillStyle = hsl(palette.background, 0.8);
  ctx.fill();
  ctx.fillStyle = hsl(palette[HEALTH_DOT[group.health]]);
  ctx.beginPath();
  ctx.arc(x + pad + dot / 2, y + height / 2, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = titleFont;
  ctx.fillStyle = hsl(palette.foreground);
  ctx.fillText(title, x + pad + dot + size * 0.35, y + height / 2);
  ctx.globalAlpha = 1;
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  edge: SceneEdge,
  palette: GraphPalette,
  highlight: SceneHighlight,
  zoom: number
) {
  const lit = !!highlight.lit?.edges.has(edge.id);
  const hovered =
    highlight.hovered !== null &&
    (highlight.hovered === edge.source || highlight.hovered === edge.target);
  let dimmed = false;
  if (highlight.lit) dimmed = !lit;
  else if (highlight.matches) {
    dimmed = !(highlight.matches.has(edge.source) || highlight.matches.has(edge.target));
  } else dimmed = highlight.problems && !edge.problem;

  const style = EDGE[edge.type];
  let color = hsl(palette[style.color], style.alpha);
  let width = style.width;
  let dash = style.dash;
  if (edge.missing) {
    color = hsl(palette.destructive, 0.8);
    dash = [4, 3];
  } else if ((lit || hovered) && (edge.type === "owns" || edge.type === "mounts" || edge.type === "selects")) {
    color = hsl(palette.primary, 0.85);
  }
  if (lit || hovered) width = 2.2;
  let alpha = 1;
  if (dimmed && !hovered) alpha = 0.1;
  else if (edge.faint && !lit && !hovered) alpha = 0.12;
  else if (edge.crossGroup && !lit && !hovered) alpha = 0.55;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(width, 1 / zoom);
  ctx.setLineDash(dash);
  const offset = controlOffset(edge.tx - edge.sx);
  ctx.beginPath();
  ctx.moveTo(edge.sx, edge.sy);
  ctx.bezierCurveTo(edge.sx + offset, edge.sy, edge.tx - offset, edge.ty, edge.tx, edge.ty);
  ctx.stroke();
  ctx.fillStyle = edge.missing
    ? hsl(palette.destructive)
    : edge.type === "routes"
      ? hsl(palette.info)
      : edge.type === "scales"
        ? hsl(palette.primary)
        : hsl(palette["muted-foreground"], 0.55);
  ctx.beginPath();
  ctx.arc(edge.tx, edge.ty, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  card: SceneCard,
  palette: GraphPalette,
  highlight: SceneHighlight,
  zoom: number,
  simple: boolean
) {
  const alpha = cardAlpha(card, highlight);
  ctx.globalAlpha = alpha;
  const selected = highlight.selected === card.id;
  const inPath = !selected && !!highlight.lit?.nodes.has(card.id);
  const matched = !highlight.lit && !!highlight.matches?.has(card.id);

  /* Body. */
  roundRect(ctx, card.x, card.y, card.width, card.height, 8);
  ctx.fillStyle = card.missing ? hsl(palette.destructive, 0.04) : hsl(palette.card);
  ctx.fill();
  if (!card.missing && (card.health === "error" || card.health === "warning")) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = hsl(palette[card.health === "error" ? "destructive" : "warning"]);
    ctx.fillRect(card.x, card.y, 3, card.height);
    ctx.restore();
    roundRect(ctx, card.x, card.y, card.width, card.height, 8);
  }
  if (card.missing || card.external) ctx.setLineDash([4, 3]);
  ctx.strokeStyle = selected
    ? hsl(palette.primary)
    : inPath
      ? hsl(palette.primary, 0.6)
      : matched
        ? hsl(palette.link)
        : card.missing
          ? hsl(palette.destructive, 0.7)
          : hsl(palette.border);
  ctx.lineWidth = Math.max(1, 0.75 / zoom);
  ctx.stroke();
  ctx.setLineDash([]);
  if (selected || matched) {
    roundRect(ctx, card.x - 2, card.y - 2, card.width + 4, card.height + 4, 10);
    ctx.strokeStyle = selected ? hsl(palette.primary, 0.3) : hsl(palette.link, 0.25);
    ctx.lineWidth = Math.max(2, 2 / zoom);
    ctx.stroke();
  }

  /* Icon tile (as the DOM card; the icon itself is left out). */
  const tile = card.compact ? 24 : 32;
  const pad = card.compact ? 8 : 10;
  const tileX = card.x + pad;
  const tileY =
    card.category === "workload" && !simple
      ? card.y + 4 + (58 - 8 - tile) / 2
      : card.y + (card.height - tile) / 2;
  if (!simple) {
    const [tileColor, tileAlpha] = card.missing
      ? (["destructive", 0.1] as [Token, number])
      : TILE[card.category];
    roundRect(ctx, tileX, tileY, tile, tile, 6);
    ctx.fillStyle = hsl(palette[tileColor], tileAlpha);
    ctx.fill();
  }

  /* Health dot. */
  const dotX = card.x + card.width - pad - 4;
  if (!card.missing && card.health !== "neutral") {
    ctx.fillStyle = hsl(palette[HEALTH_DOT[card.health]]);
    ctx.beginPath();
    ctx.arc(
      dotX,
      simple ? card.y + card.height / 2 : tileY + tile / 2,
      simple ? Math.max(4, 3 / zoom) : 4,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  /* Text: skipped when it would be unreadable anyway. */
  const textX = tileX + tile + (card.compact ? 8 : 10);
  const maxWidth = dotX - 10 - textX;
  if (simple) {
    // Names stay legible (>= ~10px on screen), as large as the card allows.
    const size = Math.min(card.height * 0.62, Math.max(18, 10 / zoom));
    if (size * zoom < 6) return;
    const nameFont = font(600, size);
    ctx.font = nameFont;
    ctx.fillStyle = hsl(palette[card.missing ? "destructive" : "foreground"]);
    const left = card.x + pad + 4;
    ctx.fillText(
      fitText(ctx, card.name, nameFont, dotX - 8 - left),
      left,
      card.y + card.height / 2
    );
    return;
  }
  const nameSize = card.compact ? 11 : 13;
  if (nameSize * zoom < 4.5) return;
  const nameFont = font(500, nameSize);
  const metaFont = font(400, card.compact ? 10 : 11);
  const center = tileY + tile / 2;
  ctx.font = nameFont;
  ctx.fillStyle = hsl(palette[card.missing ? "destructive" : "foreground"]);
  ctx.fillText(fitText(ctx, card.name, nameFont, maxWidth), textX, center - 8);
  ctx.font = metaFont;
  ctx.fillStyle = hsl(palette["muted-foreground"]);
  ctx.fillText(fitText(ctx, card.subtitle, metaFont, maxWidth), textX, center + 8);
}
