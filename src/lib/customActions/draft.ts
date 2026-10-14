/*
 * The form editor's model of an action (pure, unit tested): every field as
 * plain text / switches, to and from the file. Saving an existing file only
 * replaces the keys that changed, so comments elsewhere in it survive.
 */
import { isMap, isPair, isScalar, parseDocument, stringify } from "yaml";
import { deepEqual } from "@/components/monaco/manifest";
import { quotePosix } from "./template";
import type { ActionInput, CustomAction, RunType } from "./types";

export interface DraftInput {
  name: string;
  label: string;
  default: string;
  /** Comma-separated pick list; empty: a text field. */
  options: string;
  type: "text" | "number";
}

export interface ActionDraft {
  name: string;
  description: string;
  icon: string;
  shortcut: string;
  /** Empty: any kind. */
  kinds: string[];
  /** Comma-separated globs. */
  namespaces: string;
  contexts: string;
  labels: string;
  multiple: boolean;
  type: RunType;
  /** The template of each run type (kept while switching between them). */
  templates: Record<Exclude<RunType, "exec">, string>;
  /** exec: the command (empty: a shell) and container. */
  execCommand: string;
  execContainer: string;
  background: boolean;
  inputs: DraftInput[];
  confirm: string;
  mutates: boolean;
}

/* kubectl arguments as one line: quoted where a shell would split them (templates stay whole). */
export function joinArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      const outside = arg.replace(/\{\{.*?\}\}/g, "");
      return arg === "" || /[\s'"\\]/.test(outside) ? quotePosix(arg) : arg;
    })
    .join(" ");
}

const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function emptyDraft(): ActionDraft {
  return {
    name: "",
    description: "",
    icon: "zap",
    shortcut: "",
    kinds: ["Pod"],
    namespaces: "",
    contexts: "",
    labels: "",
    multiple: false,
    type: "open",
    templates: { open: "https://", command: "", kubectl: "", patch: "", copy: "" },
    execCommand: "",
    execContainer: "",
    background: false,
    inputs: [],
    confirm: "",
    mutates: false,
  };
}

export function draftFromAction(action: CustomAction): ActionDraft {
  const draft = emptyDraft();
  const { run } = action;
  Object.assign(draft, {
    name: action.name,
    description: action.description,
    icon: action.icon,
    shortcut: action.shortcut,
    kinds: [...action.scope.kinds],
    namespaces: action.scope.namespaces.join(", "),
    contexts: action.scope.contexts.join(", "),
    labels: action.scope.labels,
    multiple: action.scope.multiple,
    type: run.type,
    inputs: action.inputs.map((input: ActionInput) => ({
      name: input.name,
      label: input.label === input.name ? "" : input.label,
      default: input.default ?? "",
      options: (input.options ?? []).join(", "),
      type: input.type,
    })),
    confirm: action.confirm,
    mutates: action.mutates && run.type !== "patch",
  });
  switch (run.type) {
    case "open":
    case "copy":
      draft.templates[run.type] = run.template;
      break;
    case "command":
      draft.templates.command = run.template;
      draft.background = run.background;
      break;
    case "kubectl":
      draft.templates.kubectl = joinArgs(run.args);
      draft.background = run.background;
      break;
    case "exec":
      draft.execCommand = run.command;
      draft.execContainer = run.container;
      break;
    case "patch":
      draft.templates.patch = stringify(run.patch, { lineWidth: 0 }).trimEnd();
      break;
  }
  return draft;
}

/** The patch text as an object; a string is why it isn't one. */
export function parsePatchText(text: string): Record<string, unknown> | string {
  const doc = parseDocument(text);
  if (doc.errors.length) return `The patch isn't valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`;
  const value = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The patch is a mapping, like spec: { replicas: 2 }";
  return value as Record<string, unknown>;
}

/** The draft in the file's shape (defaults left out). */
export function draftToObject(draft: ActionDraft): Record<string, unknown> {
  const object: Record<string, unknown> = { name: draft.name.trim() };
  if (draft.description.trim()) object.description = draft.description.trim();
  if (draft.icon && draft.icon !== "zap") object.icon = draft.icon;
  if (draft.shortcut.trim()) object.shortcut = draft.shortcut.trim();

  const scope: Record<string, unknown> = { kinds: draft.kinds.length ? [...draft.kinds] : "*" };
  if (list(draft.namespaces).length) scope.namespaces = list(draft.namespaces);
  if (list(draft.contexts).length) scope.contexts = list(draft.contexts);
  if (draft.labels.trim()) scope.labels = draft.labels.trim();
  if (draft.multiple) scope.multiple = true;
  object.scope = scope;

  const inputs = draft.inputs
    .filter((input) => input.name.trim())
    .map((input) => {
      const entry: Record<string, unknown> = { name: input.name.trim() };
      if (input.label.trim()) entry.label = input.label.trim();
      if (input.default.trim()) entry.default = input.default.trim();
      if (list(input.options).length) entry.options = list(input.options);
      if (input.type === "number") entry.type = "number";
      return entry;
    });
  if (inputs.length) object.inputs = inputs;

  const run: Record<string, unknown> = {};
  switch (draft.type) {
    case "exec":
      run.exec = draft.execCommand.trim() || true;
      if (draft.execContainer.trim()) run.container = draft.execContainer.trim();
      break;
    case "patch": {
      const patch = parsePatchText(draft.templates.patch);
      run.patch = typeof patch === "string" ? draft.templates.patch : patch;
      break;
    }
    default:
      run[draft.type] = draft.templates[draft.type].trim();
      if ((draft.type === "command" || draft.type === "kubectl") && draft.background) run.in = "background";
  }
  object.run = run;

  if (draft.confirm.trim()) object.confirm = draft.confirm.trim();
  if (draft.mutates && draft.type !== "patch") object.mutates = true;
  return object;
}

const FORMAT = { lineWidth: 0, flowCollectionPadding: false } as const;
const FLOW_LISTS = new Set(["kinds", "namespaces", "contexts", "options"]);

/* Short lists read best on one line: kinds: [Pod, Deployment]. */
function flowLists(node: unknown, key?: string): void {
  if (!node || typeof node !== "object") return;
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return;
  if (key && FLOW_LISTS.has(key) && !isMap(node)) (node as { flow?: boolean }).flow = true;
  for (const item of items) {
    if (isPair(item)) flowLists(item.value, isScalar(item.key) ? String(item.key.value) : undefined);
    else flowLists(item);
  }
}

/**
 * The YAML of a draft. With the file's current text, only changed keys are
 * replaced (comments and formatting of the rest stay).
 */
export function draftToYaml(draft: ActionDraft, previous?: string): string {
  const object = draftToObject(draft);
  const doc = previous ? parseDocument(previous) : null;
  if (!doc || doc.errors.length || !isMap(doc.contents)) {
    const fresh = parseDocument(stringify(object, { lineWidth: 0 }));
    flowLists(fresh.contents);
    return fresh.toString(FORMAT);
  }
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(before)) {
    if (!(key in object)) {
      doc.delete(key);
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(object)) {
    if (deepEqual(before[key], value)) continue;
    const node = doc.createNode(value);
    flowLists(node, key);
    doc.set(key, node);
    changed = true;
  }
  return changed ? doc.toString(FORMAT) : previous!;
}
