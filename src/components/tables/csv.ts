/*
 * Copy rows as CSV (pure, unit tested): the text a cell shows, taken from
 * its renderer's output, quoted per RFC 4180, with a guard against cells
 * a spreadsheet would run as a formula.
 */
import { Comment, isVNode, type VNode } from "vue";

/**
 * Plain text of a cell renderer's output: strings and numbers as they are,
 * VNodes by their text children and default slots. Sibling elements get a
 * space between them (they sit apart on screen); adjacent text doesn't.
 * Components without text (a status dot) add nothing.
 */
export function renderedText(node: unknown): string {
  return collapse(textOf(node));
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return joinChildren(node);
  if (typeof node === "function") return textOf(safeCall(node as () => unknown));
  if (!isVNode(node)) return "";
  const vnode = node as VNode;
  if (vnode.type === Comment) return "";
  const children = vnode.children;
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return joinChildren(children);
  // A component's default slot.
  if (children && typeof children === "object" && "default" in children) {
    return textOf(safeCall((children as { default: () => unknown }).default));
  }
  return "";
}

function joinChildren(children: unknown[]): string {
  let text = "";
  let previousElement = false;
  for (const child of children) {
    const part = textOf(child);
    if (!part) continue;
    const element = isVNode(child) && typeof (child as VNode).type !== "symbol";
    if (text && element && previousElement) text += " ";
    text += part;
    previousElement = element;
  }
  return text;
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return "";
  }
}

/*
 * A spreadsheet runs a cell starting with = + - @ (or a tab / carriage
 * return before one) as a formula: such cells get a leading apostrophe.
 * Plain numbers and the table's "-" placeholder stay as they are.
 */
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+([.,]\d+)*|\.\d+)(e[+-]?\d+)?%?$/i;

export function escapeCsvCell(value: string): string {
  let text = value;
  if (FORMULA.test(text) && text !== "-" && !NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text: a header line, then one line per row. */
export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((cells) => cells.map(escapeCsvCell).join(",")).join("\n") + "\n";
}
