/*
 * Templates of custom actions (pure, unit tested): `{{name}}`,
 * `{{labels.app}}`, `{{annotations['x']}}`, `{{.spec.replicas}}`,
 * `{{input.since}}`, with filters (`| default "all"`, `| lower`, `| upper`,
 * `| raw`).
 *
 * Values never become code:
 * - URLs: every value is URL-encoded (`| raw` inserts a value as is, e.g. a
 *   whole URL from an annotation; the result must still be an http(s) URL).
 * - Local commands (POSIX): the script refers to the values as positional
 *   parameters ("$1", "$2", ...) that are passed next to it
 *   (`sh -c <script> sh <value>...`), so a value is data to the shell
 *   wherever it lands (quotes, $(...), backticks). PowerShell gets them as
 *   environment variables.
 * - kubectl: the template is split into arguments before rendering; values
 *   become (parts of) single arguments, no shell is involved.
 */
import { evaluateJsonPath, parseJsonPath } from "@/components/tables/printerColumns";
import type { TemplateContext } from "./types";

export const FIELDS = [
  "name",
  "namespace",
  "kind",
  "apiVersion",
  "uid",
  "context",
  "kubeconfig",
  "container",
  "image",
] as const;
export type Field = (typeof FIELDS)[number];

export type ValueRef =
  | { type: "field"; field: Field }
  | { type: "label"; key: string }
  | { type: "annotation"; key: string }
  | { type: "input"; name: string }
  | { type: "path"; path: string };

export type Filter = { type: "raw" } | { type: "lower" } | { type: "upper" } | { type: "default"; value: string };

export interface Placeholder {
  /** The text between the braces. */
  source: string;
  /** Offsets of `{{` and after `}}` in the template. */
  start: number;
  end: number;
  ref: ValueRef;
  filters: Filter[];
}

export type Segment = string | Placeholder;

export interface TemplateIssue {
  message: string;
  /** Offset in the template. */
  offset: number;
}

export interface ParsedTemplate {
  segments: Segment[];
  issues: TemplateIssue[];
}

export const isPlaceholder = (segment: Segment): segment is Placeholder => typeof segment !== "string";

const unquote = (text: string): string | null => {
  const match = /^(['"])(.*)\1$/s.exec(text.trim());
  return match ? match[2]! : null;
};

/* `labels.app.kubernetes.io/name` or `labels['app.kubernetes.io/name']`. */
const mapKey = (rest: string): string | null => {
  if (rest.startsWith(".")) return rest.slice(1) || null;
  if (rest.startsWith("[") && rest.endsWith("]")) return unquote(rest.slice(1, -1));
  return null;
};

function parseRef(text: string): ValueRef | string {
  const expr = text.trim();
  if (!expr) return "An empty {{ }}: put a variable between the braces";
  if (expr.startsWith(".")) {
    return parseJsonPath(expr) ? { type: "path", path: expr } : `"${expr}" isn't a valid path (like .spec.replicas)`;
  }
  for (const [prefix, type] of [
    ["labels", "label"],
    ["annotations", "annotation"],
  ] as const) {
    if (expr === prefix || expr.startsWith(`${prefix}.`) || expr.startsWith(`${prefix}[`)) {
      const key = mapKey(expr.slice(prefix.length));
      return key ? { type, key } : `Name the ${type} key: ${prefix}.app or ${prefix}['app.kubernetes.io/name']`;
    }
  }
  if (expr === "input" || expr.startsWith("input.")) {
    const name = expr.slice("input.".length);
    return /^[A-Za-z_][\w-]*$/.test(name) ? { type: "input", name } : "Name the input: input.<name>";
  }
  if ((FIELDS as readonly string[]).includes(expr)) return { type: "field", field: expr as Field };
  const root = /^[^.[]*/.exec(expr)![0];
  const nearest = [...FIELDS, "labels", "annotations", "input"].find((name) => editDistance(root, name) <= 2);
  return nearest
    ? `Unknown variable "${expr}": did you mean "${nearest}${expr.slice(root.length)}"?`
    : `Unknown variable "${expr}". Try name, namespace, labels.<key> or .spec.<field>`;
}

/* Levenshtein distance, for "did you mean" (short words only). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/* Splits on `|` outside quotes. */
const splitPipes = (text: string): string[] => {
  const parts: string[] = [];
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
};

function parseFilter(text: string): Filter | string {
  const filter = text.trim();
  if (filter === "raw" || filter === "lower" || filter === "upper") return { type: filter };
  const match = /^default\s+(.+)$/s.exec(filter);
  if (match) {
    const value = unquote(match[1]!) ?? match[1]!.trim();
    return { type: "default", value };
  }
  return `Unknown filter "${filter}". Use default "…", lower, upper or raw`;
}

export function parseTemplate(text: string): ParsedTemplate {
  const segments: Segment[] = [];
  const issues: TemplateIssue[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{{", index);
    if (open < 0) {
      segments.push(text.slice(index));
      break;
    }
    if (open > index) segments.push(text.slice(index, open));
    const close = text.indexOf("}}", open + 2);
    if (close < 0) {
      issues.push({ message: "A {{ without its closing }}", offset: open });
      segments.push(text.slice(open));
      break;
    }
    const source = text.slice(open + 2, close);
    const [refText, ...filterTexts] = splitPipes(source);
    const ref = parseRef(refText!);
    const filters: Filter[] = [];
    let valid = typeof ref !== "string";
    if (typeof ref === "string") issues.push({ message: ref, offset: open });
    for (const filterText of filterTexts) {
      const filter = parseFilter(filterText);
      if (typeof filter === "string") {
        issues.push({ message: filter, offset: open });
        valid = false;
      } else filters.push(filter);
    }
    if (valid) segments.push({ source: source.trim(), start: open, end: close + 2, ref: ref as ValueRef, filters });
    else segments.push(text.slice(open, close + 2));
    index = close + 2;
  }
  return { segments, issues };
}

export const placeholders = (template: ParsedTemplate | string): Placeholder[] =>
  (typeof template === "string" ? parseTemplate(template) : template).segments.filter(isPlaceholder);

/* ------------------------------------------------------------ values -- */

/** Containers of a pod, or of the pod template of a workload / CronJob. */
export function containersOf(object: Record<string, any>): { name: string; image?: string }[] {
  const spec =
    object?.spec?.jobTemplate?.spec?.template?.spec ?? object?.spec?.template?.spec ?? object?.spec;
  const list = [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])];
  return list.filter((c: any) => c && typeof c.name === "string");
}

/** A value as text: arrays as space-separated items (like kubectl), objects as JSON. */
export function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(" ");
  return JSON.stringify(value);
}

function lookup(ref: ValueRef, ctx: TemplateContext): unknown {
  const { object } = ctx;
  switch (ref.type) {
    case "label":
      return object?.metadata?.labels?.[ref.key];
    case "annotation":
      return object?.metadata?.annotations?.[ref.key];
    case "input":
      return ctx.inputs[ref.name];
    case "path":
      return evaluateJsonPath(object, ref.path);
    case "field":
      switch (ref.field) {
        case "name":
          return object?.metadata?.name;
        case "namespace":
          return object?.metadata?.namespace;
        case "kind":
          return object?.kind;
        case "apiVersion":
          return object?.apiVersion;
        case "uid":
          return object?.metadata?.uid;
        case "context":
          return ctx.context;
        case "kubeconfig":
          return ctx.kubeConfig;
        case "container":
          return ctx.container ?? containersOf(object)[0]?.name;
        case "image": {
          const containers = containersOf(object);
          const name = ctx.container ?? containers[0]?.name;
          return containers.find((c) => c.name === name)?.image;
        }
      }
  }
}

const applyFilters = (value: string, filters: Filter[]): string => {
  let result = value;
  for (const filter of filters) {
    if (filter.type === "default" && result === "") result = filter.value;
    else if (filter.type === "lower") result = result.toLowerCase();
    else if (filter.type === "upper") result = result.toUpperCase();
  }
  return result;
};

/** The text of a placeholder for one object. */
export const resolve = (placeholder: Placeholder, ctx: TemplateContext): string =>
  applyFilters(stringify(lookup(placeholder.ref, ctx)), placeholder.filters);

/**
 * The typed value of a placeholder (patches): numbers / booleans / objects
 * of paths stay what they are, number inputs become numbers.
 */
export function resolveTyped(
  placeholder: Placeholder,
  ctx: TemplateContext,
  numberInputs: ReadonlySet<string>
): unknown {
  if (placeholder.filters.length === 0) {
    const value = lookup(placeholder.ref, ctx);
    if (placeholder.ref.type === "path" && value !== undefined && typeof value !== "string") return value;
    if (placeholder.ref.type === "input" && numberInputs.has(placeholder.ref.name)) {
      const number = Number(value);
      if (String(value ?? "").trim() !== "" && Number.isFinite(number)) return number;
    }
  }
  return resolve(placeholder, ctx);
}

const hasFilter = (placeholder: Placeholder, type: Filter["type"]) =>
  placeholder.filters.some((filter) => filter.type === type);

/* ---------------------------------------------------------- rendering -- */

const toSegments = (template: ParsedTemplate | string) =>
  (typeof template === "string" ? parseTemplate(template) : template).segments;

export function renderText(template: ParsedTemplate | string, ctx: TemplateContext): string {
  return toSegments(template)
    .map((segment) => (isPlaceholder(segment) ? resolve(segment, ctx) : segment))
    .join("");
}

/** A URL: values URL-encoded unless `| raw`. */
export function renderUrl(template: ParsedTemplate | string, ctx: TemplateContext): string {
  return toSegments(template)
    .map((segment) => {
      if (!isPlaceholder(segment)) return segment;
      const value = resolve(segment, ctx);
      return hasFilter(segment, "raw") ? value : encodeURIComponent(value);
    })
    .join("");
}

/** Only web pages open in the browser (no file:, javascript:, custom schemes). */
export function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- shells -- */

export type ShellDialect = "posix" | "powershell";

/* Words that need no quotes to read (and paste) back as one argument. */
const PLAIN_WORD = /^[A-Za-z0-9_\-.,:/@%+]+$/;

/** A value as one POSIX shell word (single quotes when needed). */
export const quotePosix = (value: string): string =>
  value !== "" && PLAIN_WORD.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/* PowerShell also ends single-quoted strings at typographic single quotes. */
export const quotePowerShell = (value: string): string =>
  value !== "" && /^[A-Za-z0-9_\-./:]+$/.test(value)
    ? value
    : `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

export const quoteFor = (dialect: ShellDialect) => (dialect === "posix" ? quotePosix : quotePowerShell);

type QuoteState = "none" | "single" | "double";

/* A nesting level of a POSIX script: the top level, $( … ) or ` … `. */
interface Frame {
  state: QuoteState;
  kind: "top" | "paren" | "tick";
  /** Open plain ( … ) inside a $( … ) frame. */
  parens: number;
}

/*
 * The quote state after `text` (POSIX): quotes, backslash escapes, and
 * command substitutions, which start a fresh quoting level even inside
 * double quotes.
 */
function advancePosix(frames: Frame[], text: string): Frame[] {
  const stack = frames.map((frame) => ({ ...frame }));
  for (let i = 0; i < text.length; i++) {
    const frame = stack[stack.length - 1]!;
    const char = text[i];
    if (frame.state === "single") {
      if (char === "'") frame.state = "none";
    } else if (char === "\\") {
      i++;
    } else if (char === "$" && text[i + 1] === "(") {
      stack.push({ state: "none", kind: "paren", parens: 0 });
      i++;
    } else if (char === "`") {
      if (frame.kind === "tick" && frame.state === "none") stack.pop();
      else stack.push({ state: "none", kind: "tick", parens: 0 });
    } else if (frame.state === "double") {
      if (char === '"') frame.state = "none";
    } else if (char === "'") frame.state = "single";
    else if (char === '"') frame.state = "double";
    else if (char === "(") frame.parens++;
    else if (char === ")") {
      if (frame.parens > 0) frame.parens--;
      else if (frame.kind === "paren") stack.pop();
    }
  }
  return stack;
}

/* PowerShell: '' and `x escapes; double-quoted strings expand variables. */
function advancePowerShell(state: QuoteState, text: string): QuoteState {
  let current = state;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (current === "single") {
      if ("'‘’‚‛".includes(char)) {
        if ("'‘’‚‛".includes(text[i + 1] ?? "")) i++;
        else current = "none";
      }
    } else if (char === "`") {
      i++;
    } else if (current === "double") {
      if ('"“”„'.includes(char)) current = "none";
    } else if ("'‘’‚‛".includes(char)) current = "single";
    else if ('"“”„'.includes(char)) current = "double";
  }
  return current;
}

export interface CompiledShell {
  /** The script handed to the shell: values are referenced, never inlined. */
  script: string;
  /** Values in order: positional parameters (POSIX) or JP_ARG_<n> variables (PowerShell). */
  values: string[];
  /** What the user reads: the script with the values quoted in place. */
  display: string;
}

const posixRef = (n: number, state: QuoteState) => {
  const ref = n < 10 ? `$${n}` : `\${${n}}`;
  if (state === "double") return ref;
  if (state === "single") return `'"${ref}"'`;
  return `"${ref}"`;
};

const powerShellRef = (n: number, state: QuoteState) => {
  const ref = `\${env:JP_ARG_${n}}`;
  if (state === "single") return `'${ref}'`;
  return ref;
};

/** Environment variable name of the n-th (1-based) PowerShell value. */
export const powerShellVariable = (n: number) => `JP_ARG_${n}`;

/**
 * A command line whose values stay data: see the header. `display` quotes
 * the values for reading; it is never executed.
 */
export function compileShell(
  template: ParsedTemplate | string,
  ctx: TemplateContext,
  dialect: ShellDialect,
  /** Values already passed before this script (several scripts in one run). */
  offset = 0
): CompiledShell {
  const quote = quoteFor(dialect);
  const values: string[] = [];
  let script = "";
  let display = "";
  let frames: Frame[] = [{ state: "none", kind: "top", parens: 0 }];
  let psState: QuoteState = "none";
  const state = () => (dialect === "posix" ? frames[frames.length - 1]!.state : psState);
  for (const segment of toSegments(template)) {
    if (!isPlaceholder(segment)) {
      script += segment;
      display += segment;
      if (dialect === "posix") frames = advancePosix(frames, segment);
      else psState = advancePowerShell(psState, segment);
      continue;
    }
    const value = resolve(segment, ctx).replace(/\0/g, "");
    values.push(value);
    const n = offset + values.length;
    script += dialect === "posix" ? posixRef(n, state()) : powerShellRef(n, state());
    display += state() === "none" ? quote(value) : value;
  }
  return { script, values, display };
}

/* ------------------------------------------------------------ kubectl -- */

/**
 * Splits a kubectl template into argument templates like a shell would
 * (whitespace separates, quotes group, backslash escapes), keeping every
 * `{{ … }}` whole. Splitting happens before rendering, so a value can never
 * add arguments.
 */
export function splitArgs(text: string): { args: string[]; issue: string | null } {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (text.startsWith("{{", i)) {
      const close = text.indexOf("}}", i + 2);
      const end = close < 0 ? text.length : close + 2;
      current += text.slice(i, end);
      started = true;
      i = end - 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return { args, issue: quote ? `A ${quote} without its closing quote` : null };
}

/** kubectl arguments for one object (each argument template rendered as text). */
export const renderArgs = (args: readonly string[], ctx: TemplateContext): string[] =>
  args.map((arg) => renderText(arg, ctx));

/** `kubectl …` as the user reads it (POSIX quoting). */
export const displayArgv = (argv: readonly string[]): string => argv.map(quotePosix).join(" ");
