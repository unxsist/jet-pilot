/**
 * View helpers of the resource graph: level of detail per zoom, a spatial
 * index of the cards (hit testing / culling of what is drawn on the
 * canvas) and keyboard navigation between cards. Pure, unit tested.
 */
import type { Rect } from "./clusterGraphLayout";

/*
 * Level of detail:
 * - cards:    real (DOM) cards near the viewport, full detail
 * - simple:   cards drawn on a canvas: name and health only
 * - overview: application groups with their members as health blocks
 */
export type GraphLod = "cards" | "simple" | "overview";

/** DOM cards from this zoom up (and down to CARD_ZOOM - LOD_HYSTERESIS). */
export const CARD_ZOOM = 0.5;
/** Health blocks below this zoom. */
export const OVERVIEW_ZOOM = 0.22;
/* Zoom has to move this far past a threshold to switch back. */
const LOD_HYSTERESIS = 0.04;

/** The level of detail for `zoom`, sticky around the thresholds. */
export function lodForZoom(zoom: number, current: GraphLod | null = null): GraphLod {
  const cardsAt =
    current === "cards" ? CARD_ZOOM - LOD_HYSTERESIS : CARD_ZOOM;
  const overviewBelow =
    current === "overview" ? OVERVIEW_ZOOM + LOD_HYSTERESIS / 2 : OVERVIEW_ZOOM;
  if (zoom >= cardsAt) return "cards";
  if (zoom < overviewBelow) return "overview";
  return "simple";
}

/* ------------------------------------------------------ spatial index -- */

export interface Positioned extends Rect {
  id: string;
}

const CELL = 480;

/** Rectangles bucketed in a uniform grid: queries touch a few cells only. */
export class SpatialIndex<T extends Positioned> {
  private cells = new Map<string, T[]>();
  readonly items: T[];

  constructor(items: T[]) {
    this.items = items;
    for (const item of items) {
      const x0 = Math.floor(item.x / CELL);
      const x1 = Math.floor((item.x + item.width) / CELL);
      const y0 = Math.floor(item.y / CELL);
      const y1 = Math.floor((item.y + item.height) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(item);
          else this.cells.set(key, [item]);
        }
      }
    }
  }

  /** The item containing the point (graph coordinates), if any. */
  at(x: number, y: number): T | null {
    const list = this.cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
    if (!list) return null;
    for (const item of list) {
      if (
        x >= item.x &&
        x <= item.x + item.width &&
        y >= item.y &&
        y <= item.y + item.height
      ) {
        return item;
      }
    }
    return null;
  }

  /** Items intersecting `rect`, each once. */
  query(rect: Rect, visit: (item: T) => void) {
    const x0 = Math.floor(rect.x / CELL);
    const x1 = Math.floor((rect.x + rect.width) / CELL);
    const y0 = Math.floor(rect.y / CELL);
    const y1 = Math.floor((rect.y + rect.height) / CELL);
    const seen = new Set<T>();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(`${cx},${cy}`);
        if (!list) continue;
        for (const item of list) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (
            item.x < rect.x + rect.width &&
            rect.x < item.x + item.width &&
            item.y < rect.y + rect.height &&
            rect.y < item.y + item.height
          ) {
            visit(item);
          }
        }
      }
    }
  }
}

/* ---------------------------------------------------- arrow navigation -- */

export type Direction = "left" | "right" | "up" | "down";

const DIRECTIONS: Record<Direction, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/**
 * The card to move to from `from` with an arrow key: the closest card
 * whose centre lies in that direction (within 60 degrees of it), cards
 * off the axis weighing more. Null at the edge of the graph.
 */
export function nearestInDirection<T extends Positioned>(
  from: Rect,
  candidates: Iterable<T>,
  direction: Direction,
  exclude?: string
): T | null {
  const [dx, dy] = DIRECTIONS[direction];
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  let best: T | null = null;
  let bestScore = Infinity;
  for (const item of candidates) {
    if (item.id === exclude) continue;
    const ix = item.x + item.width / 2 - fx;
    const iy = item.y + item.height / 2 - fy;
    const along = ix * dx + iy * dy;
    if (along <= 1) continue;
    const across = Math.abs(ix * dy - iy * dx);
    // Within +-60 degrees of the direction.
    if (across > along * 1.75) continue;
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

/* -------------------------------------------------------------- search -- */

export interface SearchEntry<T> {
  item: T;
  name: string;
  /** kind, namespace and group, lower case. */
  rest: string;
}

/** Lower-cased search fields of every item (built once per model). */
export function searchEntries<
  T extends { name: string; kind: string; namespace: string; group: string },
>(items: Iterable<T>): SearchEntry<T>[] {
  const entries: SearchEntry<T>[] = [];
  for (const item of items) {
    entries.push({
      item,
      name: item.name.toLowerCase(),
      rest: `${item.kind}\u0000${item.namespace}\u0000${item.group}`.toLowerCase(),
    });
  }
  return entries;
}

/**
 * Exact (substring) matches of a query, best first: name prefix, name
 * substring (earlier and shorter first), then kind / namespace / group.
 * Null when nothing matches literally (the caller falls back to fuzzy).
 */
export function literalSearch<T>(
  entries: SearchEntry<T>[],
  query: string,
  limit = 200
): T[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { item: T; score: number }[] = [];
  for (const entry of entries) {
    const at = entry.name.indexOf(q);
    if (at === 0) {
      scored.push({ item: entry.item, score: entry.name.length - q.length });
    } else if (at > 0) {
      scored.push({ item: entry.item, score: 1000 + at * 10 + entry.name.length });
    } else if (entry.rest.includes(q)) {
      scored.push({ item: entry.item, score: 100_000 + entry.name.length });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}
