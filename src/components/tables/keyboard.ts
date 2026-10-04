/*
 * k9s-style keyboard model of the resource tables (pure, unit tested):
 * key -> command resolution, the shortcut list for the cheat sheet / menu
 * hints, and row action lookup by label.
 */
import type { RowAction } from "./types";

export type ActionId =
  "details" | "logs" | "shell" | "edit" | "describe" | "delete";

export type TableCommand =
  | { type: "move"; delta: number; extend: boolean }
  | { type: "page"; direction: 1 | -1; extend: boolean }
  | { type: "home"; extend: boolean }
  | { type: "end"; extend: boolean }
  | { type: "open" }
  | { type: "action"; action: ActionId }
  | { type: "copyName" }
  | { type: "toggleSelect" }
  | { type: "focusFilter" }
  | { type: "escape" }
  | { type: "help" }
  | { type: "collapse" }
  | { type: "expand" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Row action labels each shortcut resolves to, in order of preference
 * (case-insensitive). Works for every kind as long as its row actions use
 * these labels.
 */
export const ACTION_LABELS: Record<ActionId, string[]> = {
  details: ["View details", "Details"],
  logs: ["Logs"],
  shell: ["Shell", "Exec", "Attach"],
  edit: ["Edit YAML", "Edit"],
  describe: ["Describe"],
  delete: ["Delete", "Uninstall"],
};

/** Resolves a key press to a table command; null leaves the key alone. */
export function resolveTableKey(
  event: KeyLike,
  isMac: boolean
): TableCommand | null {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondary = isMac ? event.ctrlKey : event.metaKey;
  const shift = !!event.shiftKey;
  const key = event.key;

  if (event.altKey || secondary) {
    return null;
  }

  if (primary) {
    if (shift) return null;
    switch (key.toLowerCase()) {
      case "d":
        return { type: "action", action: "delete" };
      case "f":
        return { type: "focusFilter" };
      default:
        return null;
    }
  }

  switch (key) {
    case "ArrowDown":
    case "j":
      return { type: "move", delta: 1, extend: shift };
    case "J":
      return { type: "move", delta: 1, extend: true };
    case "ArrowUp":
    case "k":
      return { type: "move", delta: -1, extend: shift };
    case "K":
      return { type: "move", delta: -1, extend: true };
    case "PageDown":
      return { type: "page", direction: 1, extend: shift };
    case "PageUp":
      return { type: "page", direction: -1, extend: shift };
    case "Home":
      return { type: "home", extend: shift };
    case "g":
      return shift ? null : { type: "home", extend: false };
    case "End":
      return { type: "end", extend: shift };
    case "G":
      return { type: "end", extend: false };
    case "Enter":
      return shift ? null : { type: "open" };
    case " ":
    case "Spacebar":
      return { type: "toggleSelect" };
    case "/":
      return { type: "focusFilter" };
    case "Escape":
      return { type: "escape" };
    case "?":
      return { type: "help" };
    case "ArrowLeft":
      return shift ? null : { type: "collapse" };
    case "ArrowRight":
      return shift ? null : { type: "expand" };
    case "l":
      return { type: "action", action: "logs" };
    case "s":
      return { type: "action", action: "shell" };
    case "e":
      return { type: "action", action: "edit" };
    case "d":
      return { type: "action", action: "describe" };
    case "y":
      return { type: "copyName" };
    default:
      return null;
  }
}

/** Keys that are table commands; any other letter starts type-to-filter. */
export const isCommandKey = (event: KeyLike, isMac: boolean) =>
  resolveTableKey(event, isMac) !== null;

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Text fields, editors and terminals: never take keys from those. */
export function isEditableTarget(target: unknown): boolean {
  const element = target as ElementLike | null;
  if (!element || typeof element !== "object") return false;
  return (
    !!element.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(String(element.tagName)) ||
    !!element.closest?.(".monaco-editor, .xterm, [contenteditable='true']")
  );
}

/** Open overlays (dialogs, menus, listboxes) own the keyboard. */
export function isInOverlay(target: unknown): boolean {
  const element = target as ElementLike | null;
  return !!element?.closest?.(
    "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"
  );
}

/** Buttons / links / checkboxes activate themselves on Enter / Space. */
export function isActivatable(target: unknown): boolean {
  const element = target as ElementLike | null;
  if (!element?.closest) return false;
  return !!element.closest(
    "button, a[href], [role='button'], [role='checkbox'], [role='switch'], [role='tab'], [role='menuitem'], summary"
  );
}

export const clampIndex = (index: number, count: number) =>
  count <= 0 ? -1 : Math.min(Math.max(index, 0), count - 1);

/** Ids of the items between two indexes (inclusive), in list order. */
export function rangeIds<T extends { id: string }>(
  items: readonly T[],
  from: number,
  to: number
): string[] {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(items.length - 1, Math.max(from, to));
  const ids: string[] = [];
  for (let i = start; i <= end; i++) ids.push(items[i].id);
  return ids;
}

/** Label of a row action for a row (labels may depend on the row). */
export function rowActionLabel<T>(action: RowAction<T>, row: T | null): string {
  if (typeof action.label === "string") return action.label;
  return row ? action.label(row) : "";
}

/**
 * The row action a shortcut runs for a row: first label candidate that
 * matches an available action. Mass actions are included (Delete).
 */
export function findRowAction<T>(
  actions: readonly RowAction<T>[] | undefined,
  id: ActionId,
  row: T
): RowAction<T> | null {
  if (!actions?.length) return null;
  for (const candidate of ACTION_LABELS[id]) {
    const wanted = candidate.toLowerCase();
    const match = actions.find((action) => {
      if (rowActionLabel(action, row).toLowerCase() !== wanted) return false;
      if ("isAvailable" in action && action.isAvailable) {
        return action.isAvailable(row);
      }
      return true;
    });
    if (match) return match;
  }
  return null;
}

/** Action shortcut for a menu label, for kbd hints in the row menu. */
export function actionIdForLabel(label: string): ActionId | null {
  const wanted = label.toLowerCase();
  for (const [id, labels] of Object.entries(ACTION_LABELS) as [
    ActionId,
    string[],
  ][]) {
    if (labels.some((l) => l.toLowerCase() === wanted)) return id;
  }
  return null;
}

export const actionKeys = (id: ActionId, isMac: boolean): string[] =>
  ({
    details: ["↵"],
    logs: ["L"],
    shell: ["S"],
    edit: ["E"],
    describe: ["D"],
    delete: isMac ? ["⌘", "D"] : ["Ctrl", "D"],
  })[id];

export interface ShortcutGroup {
  title: string;
  items: { keys: string[][]; label: string }[];
}

/** The cheat sheet. `keys` lists alternatives, each a key combination. */
export function tableShortcuts(isMac: boolean): ShortcutGroup[] {
  const mod = isMac ? "⌘" : "Ctrl";
  return [
    {
      title: "Navigate",
      items: [
        { keys: [["J"], ["↓"]], label: "Next row" },
        { keys: [["K"], ["↑"]], label: "Previous row" },
        { keys: [["PgDn"], ["PgUp"]], label: "Page down / up" },
        { keys: [["G"], ["Home"]], label: "First row" },
        { keys: [["⇧", "G"], ["End"]], label: "Last row" },
        { keys: [["←"], ["→"]], label: "Collapse / expand group" },
      ],
    },
    {
      title: "Act on the row",
      items: [
        { keys: [["↵"]], label: "Open details" },
        { keys: [["L"]], label: "Logs" },
        { keys: [["S"]], label: "Shell" },
        { keys: [["E"]], label: "Edit YAML" },
        { keys: [["D"]], label: "Describe" },
        { keys: [["Y"]], label: "Copy name" },
        { keys: [[mod, "D"]], label: "Delete (selection or row)" },
      ],
    },
    {
      title: "Select",
      items: [
        { keys: [["Space"]], label: "Toggle row selection" },
        {
          keys: [
            ["⇧", "↓"],
            ["⇧", "↑"],
          ],
          label: "Extend selection",
        },
      ],
    },
    {
      title: "Filter",
      items: [
        { keys: [["/"], [mod, "F"]], label: "Focus the filter" },
        { keys: [["a–z"]], label: "Type to filter (other letters)" },
        { keys: [["Esc"]], label: "Clear filter / selection" },
        { keys: [["?"]], label: "Show this cheat sheet" },
      ],
    },
  ];
}
