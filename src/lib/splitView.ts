/**
 * Split view: the main area shows one or two views side by side.
 *
 * Each pane shows a route (its full path). The router always follows the
 * focused pane: the sidebar, the command palette, back / forward and links
 * inside a view navigate the pane the user last worked in, while the other
 * pane stays where it is and keeps updating. Focusing a pane navigates the
 * router to that pane's path (its view is cached, so this is instant).
 *
 * Full-width pages (Settings) are not shown in a pane: while one is open the
 * panes are put away, and the next resource view returns to the focused
 * pane.
 *
 * This module holds the pure layout model; SplitViewProvider wires it to
 * the router, RouterViewport renders it. What only user actions need
 * (opening, closing, swapping panes, workspaces) is in @/lib/splitViewOps,
 * loaded on demand.
 */
import type { InjectionKey, Ref } from "vue";

/** Provided inside each pane (SplitPaneView): its index, for PaneControls. */
export const PaneKey: InjectionKey<{ index: Readonly<Ref<number>> }> = Symbol("Pane");

export interface Pane {
  /** Stable for the life of the pane (keys its cached views). */
  id: string;
  /** Full path of the route the pane shows, e.g. "/pods?resource=pods&kind=Pod". */
  path: string;
}

export interface SplitLayout {
  /** One pane, or two side by side (left, right). */
  panes: Pane[];
  /** Index of the pane the router follows. */
  focused: number;
}

/** What workspaces store: the pane paths and which one has the focus. */
export interface SplitSnapshot {
  panes: string[];
  focused: number;
}

export const MAX_PANES = 2;

/** Default and stored width of the left pane, in percent. */
export const DEFAULT_SPLIT_SIZE = 50;
export const MIN_PANE_SIZE = 20;

let counter = 0;
export const newPaneId = () => `pane-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Routes that take the whole content area instead of a pane. */
export function isFullWidthPath(path: string): boolean {
  return path === "/settings" || path.startsWith("/settings/") || path.startsWith("/settings?");
}

export function singlePane(path: string, id = newPaneId()): SplitLayout {
  return { panes: [{ id, path }], focused: 0 };
}

export const isSplit = (layout: SplitLayout) => layout.panes.length > 1;

/** The focused pane now shows `path` (the router navigated). */
export function followRoute(layout: SplitLayout, path: string): SplitLayout {
  const focused = layout.panes[layout.focused];
  if (!focused || focused.path === path) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane, i) => (i === layout.focused ? { ...pane, path } : pane)),
  };
}

export function focusPane(layout: SplitLayout, index: number): SplitLayout {
  if (index === layout.focused || !layout.panes[index]) return layout;
  return { ...layout, focused: index };
}

export function snapshotSplit(layout: SplitLayout): SplitSnapshot | null {
  if (!isSplit(layout)) return null;
  return { panes: layout.panes.map((pane) => pane.path), focused: layout.focused };
}

export function clampSplitSize(value: unknown): number {
  const size = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SPLIT_SIZE;
  return Math.min(100 - MIN_PANE_SIZE, Math.max(MIN_PANE_SIZE, size));
}
