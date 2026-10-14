/*
 * Action files (pure, unit tested): YAML text → a CustomAction, or the
 * first problem with the line it is on. A broken file is listed with its
 * problem in Settings › Actions; it never breaks anything else. The JSON
 * schema for the editor (./jsonSchema.ts) describes the same format.
 */
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import { parseSelector } from "./scope";
import { ACTION_ICON_NAMES, DEFAULT_ACTION_ICON } from "./icons";
import { parseTemplate, placeholders, splitArgs, type ParsedTemplate } from "./template";
import {
  RUN_TYPES,
  type ActionInput,
  type ActionProblem,
  type ActionRun,
  type ActionScope,
  type CustomAction,
  type RunType,
} from "./types";

/** Files larger than this aren't read (an action is a few lines). */
export const MAX_ACTION_FILE_BYTES = 64 * 1024;
/** Files beyond this many aren't loaded. */
export const MAX_ACTION_FILES = 200;
export const ACTIONS_DIR = "actions";

export const isActionFileName = (name: string) => /\.ya?ml$/i.test(name) && !name.startsWith(".");
export const actionIdOf = (file: string) => file.replace(/\.ya?ml$/i, "");

/** A file name for an action called `name`: "Open in Grafana" → "open-in-grafana.yaml", unique. */
export function fileNameFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 48)
      .replace(/^-|-$/g, "") || "action";
  const used = new Set(taken.map((file) => actionIdOf(file).toLowerCase()));
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  return `${candidate}.yaml`;
}

const TOP_KEYS = ["name", "description", "icon", "shortcut", "scope", "inputs", "run", "confirm", "mutates"];
const SCOPE_KEYS = ["kinds", "namespaces", "contexts", "labels", "multiple"];
const INPUT_KEYS = ["name", "label", "default", "placeholder", "options", "type"];
const RUN_OPTION_KEYS: Record<RunType, string[]> = {
  open: [],
  copy: [],
  command: ["in"],
  kubectl: ["in"],
  exec: ["container"],
  patch: [],
};

type Path = (string | number)[];

class Problem extends Error {
  constructor(
    message: string,
    readonly path: Path,
    /** Offset inside the value (template issues). */
    readonly offset?: number
  ) {
    super(message);
  }
}

const fail = (message: string, path: Path, offset?: number): never => {
  throw new Problem(message, path, offset);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const checkKeys = (value: Record<string, unknown>, allowed: string[], path: Path, where: string) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`Unknown key "${key}" ${where}. Use ${allowed.join(", ")}`, [...path, key]);
    }
  }
};

const optionalString = (value: unknown, path: Path, label: string): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") fail(`${label} must be text`, path);
  return (value as string).trim();
};

/* A string or a list of strings (`kinds: Pod` or `kinds: [Pod, Deployment]`). */
const stringList = (value: unknown, path: Path, label: string): string[] => {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, index) => {
    if (typeof item !== "string" && typeof item !== "number") {
      fail(`${label} must be text or a list of text`, Array.isArray(value) ? [...path, index] : path);
    }
    return String(item).trim();
  }).filter(Boolean);
};

const SHORTCUT_MODIFIERS = ["mod", "ctrl", "alt", "shift", "cmd", "meta"];
const SHORTCUT_KEY = /^([a-z0-9]|f([1-9]|1[0-2]))$/i;

/** "Mod+Shift+G": modifiers (Mod, Ctrl, Alt, Shift, Cmd) and one key; null when valid. */
export function shortcutProblem(shortcut: string): string | null {
  const parts = shortcut.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  if (!SHORTCUT_KEY.test(key)) return `"${key}" can't be a shortcut key: use a letter, digit or F1–F12`;
  const modifiers = parts.map((part) => part.toLowerCase());
  const unknown = modifiers.find((modifier) => !SHORTCUT_MODIFIERS.includes(modifier));
  if (unknown !== undefined) return `"${unknown}" isn't a modifier: use Mod, Ctrl, Alt, Shift or Cmd`;
  if (!modifiers.some((modifier) => modifier !== "shift")) {
    return "A shortcut needs Mod, Ctrl, Alt or Cmd, so typing never runs it";
  }
  return null;
}

/* Templates: syntax, declared inputs, and where `| raw` is allowed. */
function checkTemplate(
  text: string,
  path: Path,
  inputs: ActionInput[],
  options: { raw: boolean }
): ParsedTemplate {
  const parsed = parseTemplate(text);
  const issue = parsed.issues[0];
  if (issue) fail(issue.message, path, issue.offset);
  for (const placeholder of placeholders(parsed)) {
    if (placeholder.ref.type === "input" && !inputs.some((input) => input.name === (placeholder.ref as { name: string }).name)) {
      fail(`{{${placeholder.source}}} needs an input named "${placeholder.ref.name}" under inputs`, path, placeholder.start);
    }
    if (!options.raw && placeholder.filters.some((filter) => filter.type === "raw")) {
      fail("| raw only works in URLs and copied text: values in commands are always passed safely", path, placeholder.start);
    }
  }
  return parsed;
}

function parseScope(value: unknown): ActionScope {
  const scope: ActionScope = { kinds: [], namespaces: [], contexts: [], labels: "", multiple: false };
  if (value === undefined || value === null) return scope;
  if (!isObject(value)) return fail("scope must be a mapping (kinds, namespaces, contexts, labels, multiple)", ["scope"]);
  checkKeys(value, SCOPE_KEYS, ["scope"], "in scope");
  scope.kinds = stringList(value.kinds, ["scope", "kinds"], "scope.kinds");
  if (scope.kinds.includes("*")) scope.kinds = [];
  scope.namespaces = stringList(value.namespaces, ["scope", "namespaces"], "scope.namespaces");
  scope.contexts = stringList(value.contexts, ["scope", "contexts"], "scope.contexts");
  scope.labels = optionalString(value.labels, ["scope", "labels"], "scope.labels");
  if (scope.labels) {
    const selector = parseSelector(scope.labels);
    if (typeof selector === "string") fail(selector, ["scope", "labels"]);
  }
  if (value.multiple !== undefined && typeof value.multiple !== "boolean") {
    fail("scope.multiple must be true or false", ["scope", "multiple"]);
  }
  scope.multiple = value.multiple === true;
  return scope;
}

function parseInputs(value: unknown): ActionInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail("inputs must be a list", ["inputs"]);
  const inputs: ActionInput[] = [];
  value.forEach((item, index) => {
    const path: Path = ["inputs", index];
    if (!isObject(item)) fail("Each input must be a mapping with at least a name", path);
    const entry = item as Record<string, unknown>;
    checkKeys(entry, INPUT_KEYS, path, "in an input");
    const name = optionalString(entry.name, [...path, "name"], "An input's name");
    if (!/^[A-Za-z_][\w-]*$/.test(name)) {
      fail("Give each input a name of letters, digits, - or _ (used as {{input.<name>}})", [...path, "name"]);
    }
    if (inputs.some((input) => input.name === name)) fail(`Two inputs are named "${name}"`, [...path, "name"]);
    const type = entry.type === undefined ? "text" : entry.type;
    if (type !== "text" && type !== "number") fail('An input\'s type is "text" or "number"', [...path, "type"]);
    const options = stringList(entry.options, [...path, "options"], "options");
    const input: ActionInput = {
      name,
      label: optionalString(entry.label, [...path, "label"], "label") || name,
      type: type as ActionInput["type"],
    };
    const fallback = optionalString(entry.default, [...path, "default"], "default");
    if (entry.default !== undefined && entry.default !== null) input.default = fallback;
    const placeholder = optionalString(entry.placeholder, [...path, "placeholder"], "placeholder");
    if (placeholder) input.placeholder = placeholder;
    if (options.length) input.options = options;
    inputs.push(input);
  });
  return inputs;
}

/* Every string in a patch is a template. */
function checkPatchStrings(value: unknown, path: Path, inputs: ActionInput[]): void {
  if (typeof value === "string") checkTemplate(value, path, inputs, { raw: true });
  else if (Array.isArray(value)) value.forEach((item, index) => checkPatchStrings(item, [...path, index], inputs));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) checkPatchStrings(item, [...path, key], inputs);
}

function parseRun(value: unknown, inputs: ActionInput[]): ActionRun {
  const hint = `run needs one of ${RUN_TYPES.join(", ")}`;
  if (!isObject(value)) return fail(value === undefined ? `Say what the action does: ${hint}` : `run must be a mapping: ${hint}`, ["run"]);
  const types = RUN_TYPES.filter((type) => type in value);
  if (types.length === 0) return fail(hint, ["run"]);
  if (types.length > 1) return fail(`run has ${types.join(" and ")}: an action does one thing`, ["run", types[1]!]);
  const type = types[0]!;
  checkKeys(value, [type, ...RUN_OPTION_KEYS[type]], ["run"], `next to ${type}`);
  const path: Path = ["run", type];
  const raw = value[type];

  const background = (() => {
    if (value.in === undefined) return false;
    if (value.in !== "terminal" && value.in !== "background") fail('run.in is "terminal" or "background"', ["run", "in"]);
    return value.in === "background";
  })();

  switch (type) {
    case "open":
    case "copy": {
      const template = optionalString(raw, path, `run.${type}`);
      if (!template) fail(type === "open" ? "Give the URL to open" : "Give the text to copy", path);
      checkTemplate(template, path, inputs, { raw: true });
      if (type === "open" && !/^(https?:\/\/|\{\{)/i.test(template)) {
        fail("The URL must start with http:// or https://", path);
      }
      return { type, template };
    }
    case "command": {
      const template = optionalString(raw, path, "run.command");
      if (!template) fail("Give the command to run", path);
      checkTemplate(template, path, inputs, { raw: false });
      return { type, template, background };
    }
    case "kubectl": {
      let args: string[];
      if (Array.isArray(raw)) {
        args = stringList(raw, path, "run.kubectl");
      } else {
        const text = optionalString(raw, path, "run.kubectl");
        const split = splitArgs(text);
        if (split.issue) fail(split.issue, path);
        args = split.args;
      }
      if (args[0] === "kubectl") args = args.slice(1);
      if (args.length === 0) fail("Give the kubectl arguments, like: logs -f {{name}}", path);
      args.forEach((arg) => checkTemplate(arg, path, inputs, { raw: false }));
      return { type, args, background };
    }
    case "exec": {
      const command = raw === true ? "" : optionalString(raw, path, "run.exec");
      if (command) checkTemplate(command, path, inputs, { raw: false });
      const container = optionalString(value.container, ["run", "container"], "run.container");
      if (container) checkTemplate(container, ["run", "container"], inputs, { raw: false });
      return { type, command, container };
    }
    case "patch": {
      if (!isObject(raw)) return fail("run.patch must be a mapping: the merge patch, like spec: { replicas: 2 }", path);
      checkPatchStrings(raw, path, inputs);
      return { type, patch: raw };
    }
  }
}

function toAction(id: string, value: unknown): CustomAction {
  if (!isObject(value)) return fail("An action file is a mapping with at least name and run", []);
  checkKeys(value, TOP_KEYS, [], "at the top");
  const name = optionalString(value.name, ["name"], "name");
  if (!name) fail("Give the action a name", ["name"]);
  if (name.length > 60) fail("Keep the name under 60 characters", ["name"]);
  const icon = optionalString(value.icon, ["icon"], "icon") || DEFAULT_ACTION_ICON;
  if (!ACTION_ICON_NAMES.includes(icon)) {
    fail(`Unknown icon "${icon}". Use one of ${ACTION_ICON_NAMES.join(", ")}`, ["icon"]);
  }
  const shortcut = optionalString(value.shortcut, ["shortcut"], "shortcut");
  if (shortcut) {
    const problem = shortcutProblem(shortcut);
    if (problem) fail(problem, ["shortcut"]);
  }
  const inputs = parseInputs(value.inputs);
  const run = parseRun(value.run, inputs);
  let confirm = "";
  if (value.confirm === true) confirm = `Run ${name} on {{name}}?`;
  else if (value.confirm !== undefined && value.confirm !== false && value.confirm !== null) {
    confirm = optionalString(value.confirm, ["confirm"], "confirm");
    checkTemplate(confirm, ["confirm"], inputs, { raw: true });
  }
  if (value.mutates !== undefined && typeof value.mutates !== "boolean") fail("mutates must be true or false", ["mutates"]);
  return {
    id,
    name,
    description: optionalString(value.description, ["description"], "description"),
    icon,
    shortcut,
    scope: parseScope(value.scope),
    inputs,
    run,
    confirm,
    // A patch always changes the cluster.
    mutates: value.mutates === true || run.type === "patch",
  };
}

type RangedNode = { range?: [number, number, number] | null; value?: unknown; type?: string } | null | undefined;

/*
 * 1-based line of `path` in the document: the key of a mapping entry (the
 * value of a collection starts on a later line), the line of a template
 * issue inside a string, else the closest existing parent.
 */
function lineOf(doc: Document, counter: LineCounter, path: Path, offset?: number): number | undefined {
  const nodeAt = (at: Path): RangedNode => (at.length === 0 ? doc.contents : (doc.getIn(at, true) as RangedNode));
  for (let depth = path.length; depth >= 0; depth--) {
    const node = nodeAt(path.slice(0, depth));
    if (depth === path.length && offset !== undefined && isScalar(node) && typeof node.value === "string" && node.range) {
      const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
      const newlines = node.value.slice(0, offset).match(/\n/g)?.length ?? 0;
      return counter.linePos(node.range[0]).line + (block ? 1 : 0) + newlines;
    }
    const parent = depth > 0 ? nodeAt(path.slice(0, depth - 1)) : null;
    if (isMap(parent)) {
      const pair = parent.items.find((item) => (isScalar(item.key) ? item.key.value : item.key) === path[depth - 1]);
      const range = (pair?.key as RangedNode)?.range;
      if (range) return counter.linePos(range[0]).line;
    }
    if (node?.range) return counter.linePos(node.range[0]).line;
  }
  return undefined;
}

export interface ParsedActionFile {
  action: CustomAction | null;
  error: ActionProblem | null;
}

export function parseActionFile(file: string, text: string): ParsedActionFile {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) {
    // Errors at the end of the file (an unclosed bracket) point at its last line.
    const lastLine = Math.max(1, text.trimEnd().split("\n").length);
    const line = Math.min(yamlError.linePos?.[0]?.line ?? counter.linePos(yamlError.pos[0]).line, lastLine);
    const message = yamlError.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
    return { action: null, error: { message: `Not valid YAML: ${message}`, line } };
  }
  if (doc.contents === null) {
    return { action: null, error: { message: "The file is empty: an action needs at least name and run", line: 1 } };
  }
  try {
    return { action: toAction(actionIdOf(file), doc.toJS()), error: null };
  } catch (e) {
    if (e instanceof Problem) {
      return {
        action: null,
        error: { message: e.message, line: lineOf(doc, counter, e.path, e.offset), path: e.path.join(".") },
      };
    }
    return { action: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}
