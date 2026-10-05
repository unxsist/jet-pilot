import { describe, expect, test, vi } from "vitest";
import {
  actionIdForLabel,
  clampIndex,
  findRowAction,
  isActivatable,
  isCommandKey,
  isEditableTarget,
  isInOverlay,
  rangeIds,
  resolveTableKey,
  tableShortcuts,
} from "@/components/tables/keyboard";
import type { RowAction } from "@/components/tables/types";

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("resolveTableKey", () => {
  test("cursor movement", () => {
    expect(resolveTableKey(key("j"), false, true)).toEqual({
      type: "move",
      delta: 1,
      extend: false,
    });
    expect(resolveTableKey(key("ArrowDown"), false)).toEqual({
      type: "move",
      delta: 1,
      extend: false,
    });
    expect(resolveTableKey(key("k"), false, true)).toEqual({
      type: "move",
      delta: -1,
      extend: false,
    });
    expect(resolveTableKey(key("ArrowUp"), false)).toEqual({
      type: "move",
      delta: -1,
      extend: false,
    });
    expect(resolveTableKey(key("PageDown"), false)).toEqual({
      type: "page",
      direction: 1,
      extend: false,
    });
    expect(resolveTableKey(key("PageUp"), false)).toEqual({
      type: "page",
      direction: -1,
      extend: false,
    });
    expect(resolveTableKey(key("g"), false, true)).toEqual({
      type: "home",
      extend: false,
    });
    expect(resolveTableKey(key("Home"), false)).toEqual({
      type: "home",
      extend: false,
    });
    expect(resolveTableKey(key("G", { shiftKey: true }), false, true)).toEqual({
      type: "end",
      extend: false,
    });
    expect(resolveTableKey(key("End"), false)).toEqual({
      type: "end",
      extend: false,
    });
  });

  test("shift + arrows extend the selection", () => {
    expect(
      resolveTableKey(key("ArrowDown", { shiftKey: true }), false)
    ).toEqual({ type: "move", delta: 1, extend: true });
    expect(resolveTableKey(key("ArrowUp", { shiftKey: true }), false)).toEqual({
      type: "move",
      delta: -1,
      extend: true,
    });
    expect(resolveTableKey(key("J", { shiftKey: true }), false, true)).toEqual({
      type: "move",
      delta: 1,
      extend: true,
    });
  });

  test("row actions", () => {
    expect(resolveTableKey(key("Enter"), false)).toEqual({ type: "open" });
    expect(resolveTableKey(key("l"), false, true)).toEqual({
      type: "action",
      action: "logs",
    });
    expect(resolveTableKey(key("s"), false, true)).toEqual({
      type: "action",
      action: "shell",
    });
    expect(resolveTableKey(key("e"), false, true)).toEqual({
      type: "action",
      action: "edit",
    });
    expect(resolveTableKey(key("d"), false, true)).toEqual({
      type: "action",
      action: "describe",
    });
    expect(resolveTableKey(key("y"), false, true)).toEqual({ type: "copyName" });
    expect(resolveTableKey(key(" "), false, true)).toEqual({ type: "toggleSelect" });
  });

  test("Ctrl+D deletes on Linux / Windows, Cmd+D on macOS", () => {
    expect(resolveTableKey(key("d", { ctrlKey: true }), false)).toEqual({
      type: "action",
      action: "delete",
    });
    expect(resolveTableKey(key("d", { metaKey: true }), true)).toEqual({
      type: "action",
      action: "delete",
    });
    // the other platform's modifier is not ours
    expect(resolveTableKey(key("d", { metaKey: true }), false)).toBeNull();
    expect(resolveTableKey(key("d", { ctrlKey: true }), true)).toBeNull();
  });

  test("filter, escape and help", () => {
    expect(resolveTableKey(key("/"), false)).toEqual({ type: "focusFilter" });
    expect(resolveTableKey(key("f", { ctrlKey: true }), false)).toEqual({
      type: "focusFilter",
    });
    expect(resolveTableKey(key("f", { metaKey: true }), true)).toEqual({
      type: "focusFilter",
    });
    expect(resolveTableKey(key("Escape"), false)).toEqual({ type: "escape" });
    expect(resolveTableKey(key("?", { shiftKey: true }), false)).toEqual({
      type: "help",
    });
  });

  test("leaves other keys and shortcuts alone", () => {
    for (const k of ["a", "n", "x", "1", "Tab", "F5"]) {
      expect(resolveTableKey(key(k), false)).toBeNull();
    }
    // app shortcuts (palette, pinned resources, reload) keep working
    expect(resolveTableKey(key("k", { ctrlKey: true }), false)).toBeNull();
    expect(resolveTableKey(key("1", { ctrlKey: true }), false)).toBeNull();
    expect(resolveTableKey(key("j", { altKey: true }), false)).toBeNull();
    expect(
      resolveTableKey(key("d", { ctrlKey: true, shiftKey: true }), false)
    ).toBeNull();
  });

  test("letters that are not commands start type-to-filter", () => {
    expect(isCommandKey(key("n"), false, true)).toBe(false);
    expect(isCommandKey(key("j"), false, true)).toBe(true);
  });

  test("filter mode: letters filter, they never run commands", () => {
    // typing "deploy" must filter, not Describe / Edit / ...
    for (const k of [..."deploy", ..."jklsgy", "G", "J", "K", " "]) {
      expect(resolveTableKey(key(k), false)).toBeNull();
      expect(isCommandKey(key(k), false)).toBe(false);
    }
    // navigation keys enter row mode, modifier combos / Enter / Esc / ? / "/"
    // work in both modes
    expect(resolveTableKey(key("ArrowDown"), false)).toEqual({
      type: "move",
      delta: 1,
      extend: false,
    });
    expect(resolveTableKey(key("End"), false)).toEqual({
      type: "end",
      extend: false,
    });
    expect(resolveTableKey(key("d", { ctrlKey: true }), false)).toEqual({
      type: "action",
      action: "delete",
    });
    expect(resolveTableKey(key("Enter"), false)).toEqual({ type: "open" });
    expect(resolveTableKey(key("Escape"), false)).toEqual({ type: "escape" });
    expect(resolveTableKey(key("/"), false)).toEqual({ type: "focusFilter" });
    expect(resolveTableKey(key("?", { shiftKey: true }), false)).toEqual({
      type: "help",
    });
  });

  test("row mode: the letter commands apply", () => {
    expect(resolveTableKey(key("d"), false, true)).toEqual({
      type: "action",
      action: "describe",
    });
    expect(resolveTableKey(key("d"), false, false)).toBeNull();
  });
});

describe("key targets", () => {
  const element = (
    tagName: string,
    matches: string[] = [],
    editable = false
  ) => ({
    tagName,
    isContentEditable: editable,
    closest: (selector: string) =>
      matches.some((m) => selector.includes(m)) ? {} : null,
  });

  test("inputs, editors and terminals are never hijacked", () => {
    expect(isEditableTarget(element("INPUT"))).toBe(true);
    expect(isEditableTarget(element("TEXTAREA"))).toBe(true);
    expect(isEditableTarget(element("SELECT"))).toBe(true);
    expect(isEditableTarget(element("DIV", [], true))).toBe(true);
    expect(isEditableTarget(element("DIV", [".monaco-editor"]))).toBe(true);
    expect(isEditableTarget(element("TEXTAREA", [".xterm"]))).toBe(true);
    expect(isEditableTarget(element("BODY"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test("open overlays own the keyboard", () => {
    expect(isInOverlay(element("BUTTON", ["[role='dialog']"]))).toBe(true);
    expect(isInOverlay(element("DIV", ["[role='menu']"]))).toBe(true);
    expect(isInOverlay(element("BODY"))).toBe(false);
  });

  test("buttons keep Enter / Space", () => {
    expect(isActivatable(element("BUTTON", ["button"]))).toBe(true);
    expect(isActivatable(element("BUTTON", ["[role='checkbox']"]))).toBe(true);
    expect(isActivatable(element("DIV"))).toBe(false);
  });
});

describe("cursor helpers", () => {
  test("clampIndex", () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(4, 10)).toBe(4);
    expect(clampIndex(40, 10)).toBe(9);
    expect(clampIndex(0, 0)).toBe(-1);
  });

  test("rangeIds is inclusive in both directions", () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    expect(rangeIds(items, 1, 3)).toEqual(["b", "c", "d"]);
    expect(rangeIds(items, 3, 1)).toEqual(["b", "c", "d"]);
    expect(rangeIds(items, 2, 2)).toEqual(["c"]);
    expect(rangeIds(items, 3, 99)).toEqual(["d", "e"]);
  });
});

describe("row actions by label", () => {
  type Row = { name: string; cordoned?: boolean };
  const row: Row = { name: "web-0" };
  const handler = vi.fn();
  const actions: RowAction<Row>[] = [
    { label: "View details", handler },
    { label: "Edit YAML", handler },
    { label: "Describe", handler },
    { label: "Delete", massAction: true, handler },
    { label: "Logs", options: () => [{ label: "All containers", handler }] },
    { label: "Shell", isAvailable: (r) => !r.cordoned, handler },
    { label: (r) => (r.cordoned ? "Uncordon" : "Cordon"), handler },
  ];

  test("resolves every shortcut", () => {
    expect(findRowAction(actions, "details", row)).toBe(actions[0]);
    expect(findRowAction(actions, "edit", row)).toBe(actions[1]);
    expect(findRowAction(actions, "describe", row)).toBe(actions[2]);
    expect(findRowAction(actions, "delete", row)).toBe(actions[3]);
    expect(findRowAction(actions, "logs", row)).toBe(actions[4]);
    expect(findRowAction(actions, "shell", row)).toBe(actions[5]);
  });

  test("respects availability and missing actions", () => {
    expect(
      findRowAction(actions, "shell", { name: "x", cordoned: true })
    ).toBeNull();
    expect(findRowAction([], "logs", row)).toBeNull();
    expect(findRowAction(undefined, "logs", row)).toBeNull();
  });

  test("falls back to alternative labels (Helm: Uninstall, generic: Edit)", () => {
    const helm: RowAction<Row>[] = [
      { label: "Edit", handler },
      { label: "Uninstall", massAction: true, handler },
    ];
    expect(findRowAction(helm, "edit", row)).toBe(helm[0]);
    expect(findRowAction(helm, "delete", row)).toBe(helm[1]);
  });

  test("menu hints map labels back to shortcuts", () => {
    expect(actionIdForLabel("Edit YAML")).toBe("edit");
    expect(actionIdForLabel("logs")).toBe("logs");
    expect(actionIdForLabel("Port Forward")).toBeNull();
  });

  test("the cheat sheet lists every action shortcut", () => {
    const labels = tableShortcuts(false).flatMap((g) =>
      g.items.map((i) => i.label)
    );
    for (const label of [
      "Logs",
      "Shell",
      "Edit YAML",
      "Describe",
      "Copy name",
      "Open details",
    ]) {
      expect(labels).toContain(label);
    }
    const mac = JSON.stringify(tableShortcuts(true));
    expect(mac).toContain("⌘");
    // filtering is the default; the letter commands are marked as row mode
    const groups = tableShortcuts(false);
    expect(groups[0].items[0].label).toBe("Type to filter");
    expect(
      groups.find((g) => g.title === "Act on the row")?.note
    ).toMatch(/row mode/);
    expect(labels).toContain("Leave row mode (back to filtering)");
  });
});
