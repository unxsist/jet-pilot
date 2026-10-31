/**
 * Split view changes that only user actions need (see @/lib/splitView),
 * loaded on demand: opening, closing and swapping panes, the split of a
 * workspace, and the palette commands.
 */
import type { Component } from "vue";
import type { RouteLocationRaw, RouteRecordNormalized } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import type { Command } from "@/command-palette";
import type { SplitView, SplitViewState } from "@/providers/SplitViewProvider";
import {
  isFullWidthPath,
  isSplit,
  MAX_PANES,
  newPaneId,
  type SplitLayout,
  type SplitSnapshot,
} from "@/lib/splitView";

/**
 * Shows `path` next to the focused pane and focuses it: a second pane is
 * added on the right, or the other pane of a split is reused.
 */
export function openToSide(layout: SplitLayout, path: string, id = newPaneId()): SplitLayout {
  if (layout.panes.length < MAX_PANES) {
    return { panes: [...layout.panes, { id, path }], focused: layout.panes.length };
  }
  const other = layout.focused === 0 ? 1 : 0;
  return {
    panes: layout.panes.map((pane, i) => (i === other ? { ...pane, path } : pane)),
    focused: other,
  };
}

/** Closes a pane; the remaining one gets the focus. The last pane stays. */
export function closePane(layout: SplitLayout, index: number): SplitLayout {
  if (layout.panes.length < 2 || !layout.panes[index]) return layout;
  const panes = layout.panes.filter((_, i) => i !== index);
  return { panes, focused: 0 };
}

/** The two panes trade places (the focus moves with its pane). */
export function swapPanes(layout: SplitLayout): SplitLayout {
  if (layout.panes.length < 2) return layout;
  return { panes: [layout.panes[1], layout.panes[0]], focused: layout.focused === 0 ? 1 : 0 };
}

/** A stored split (workspaces), or null when it isn't usable. */
export function parseSplitSnapshot(value: unknown): SplitSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const { panes, focused } = value as Record<string, unknown>;
  if (!Array.isArray(panes)) return null;
  const paths = panes.filter(
    (p): p is string => typeof p === "string" && p.startsWith("/") && !isFullWidthPath(p)
  );
  if (paths.length !== MAX_PANES) return null;
  return {
    panes: paths,
    focused: focused === 1 ? 1 : 0,
  };
}

/** The layout of a stored split, reusing pane ids where the paths match. */
export function layoutFromSnapshot(snapshot: SplitSnapshot, current: SplitLayout): SplitLayout {
  const unused = [...current.panes];
  const panes = snapshot.panes.map((path) => {
    const index = unused.findIndex((pane) => pane.path === path);
    const reused = index === -1 ? null : unused.splice(index, 1)[0];
    return { id: reused?.id ?? newPaneId(), path };
  });
  return { panes, focused: snapshot.focused };
}

/* ------------------------------------------- actions (SplitViewProvider) -- */

const otherPane = (layout: SplitLayout) => (layout.focused === 0 ? 1 : 0);

export function close(state: SplitViewState, index: number) {
  const next = closePane(state.layout.value, index);
  if (next === state.layout.value) return;
  state.layout.value = next;
  if (!state.suspended.value) state.navigate(next.panes[0].path, true);
}

export function openBeside(state: SplitViewState, to: RouteLocationRaw) {
  const path = state.router.resolve(to).fullPath;
  if (!isFullWidthPath(path)) state.layout.value = openToSide(state.layout.value, path);
  state.navigate(path, false);
}

/** Splits (the previous view opens beside the current one) or closes the other pane. */
export function toggle(state: SplitViewState) {
  const layout = state.layout.value;
  if (isSplit(layout)) {
    close(state, otherPane(layout));
    return;
  }
  const here = layout.panes[0]?.path || state.router.currentRoute.value.fullPath;
  const previous = state.previousPath();
  openBeside(state, previous && previous !== here ? previous : here);
}

export function swap(state: SplitViewState) {
  state.layout.value = swapPanes(state.layout.value);
}

/*
 * Panes render loaded views; the router loads a view's component (and
 * replaces the record's `() => import(...)`) when it first navigates there.
 * A workspace's split may show a view it never visited: load it the same way.
 */
type Loader = () => Promise<{ default?: Component } | Component>;
async function loadViews(records: RouteRecordNormalized[]) {
  const pending = records.flatMap((record) =>
    Object.entries(record.components ?? {})
      .filter(([, component]) => typeof component === "function")
      .map(async ([name, component]) => {
        const loaded = await (component as unknown as Loader)();
        (record.components as Record<string, Component>)[name] =
          (loaded as { default?: Component }).default ?? (loaded as Component);
      })
  );
  await Promise.all(pending).catch(() => undefined);
}

/** A workspace's split; anything else leaves the focused view on its own. */
export async function restore(state: SplitViewState, value: unknown) {
  const snapshot = parseSplitSnapshot(value);
  if (snapshot) {
    await loadViews(snapshot.panes.flatMap((path) => state.router.resolve(path).matched));
    state.layout.value = layoutFromSnapshot(snapshot, state.layout.value);
    return;
  }
  const layout = state.layout.value;
  if (isSplit(layout)) state.layout.value = closePane(layout, otherPane(layout));
}

export function registerCommands(registerCommand: (command: Command) => void, split: SplitView) {
  const isMac = getOsType() === "macos";
  registerCommand({
    id: "split-view-toggle",
    name: "Split view",
    description: "Show two views side by side, or close the other one",
    shortcut: isMac ? ["⌘", "\\"] : ["Ctrl", "\\"],
    keywords: ["split", "side by side", "pane", "columns", "layout"],
    execute: () => void split.toggle(),
  });
  registerCommand({
    id: "split-view-focus-other",
    name: "Focus the other pane",
    description: "Split view: work in the other view",
    keywords: ["split", "pane", "switch"],
    execute: () => {
      if (split.isSplit.value) split.focus(otherPane(split.layout.value));
    },
  });
  registerCommand({
    id: "split-view-swap",
    name: "Swap the panes",
    description: "Split view: the views trade sides",
    keywords: ["split", "pane", "move", "left", "right"],
    execute: () => void split.swap(),
  });
}
