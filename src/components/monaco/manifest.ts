/*
 * Pure helpers behind the editor's review / apply flow: structural change
 * summaries, rebasing edits onto a newer object, mapping kubectl / API
 * errors to YAML lines, and normalising objects for cross-context diffs.
 *
 * No Monaco / Tauri imports: unit-tested in tests/unit/editor-manifest.test.ts.
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Node as YamlNode, Document } from "yaml";

export type PathSegment = string | number;
export type Path = PathSegment[];

export interface Change {
  path: Path;
  type: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
};

/** `spec.template.spec.containers[0].image` */
export const formatPath = (path: Path): string =>
  path.reduce<string>((out, seg) => {
    if (typeof seg === "number") return `${out}[${seg}]`;
    if (/^[A-Za-z_$][\w$-]*$/.test(seg)) return out ? `${out}.${seg}` : seg;
    return `${out}[${seg}]`;
  }, "");

/**
 * Parses a Kubernetes field path (`spec.containers[0].image`,
 * `metadata.labels[app.kubernetes.io/name]`) into segments.
 */
export const parseFieldPath = (value: string): Path => {
  const path: Path = [];
  const re = /\.?([^.[\]]+)|\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    if (match[1] !== undefined) path.push(match[1]);
    else path.push(/^\d+$/.test(match[2]) ? Number(match[2]) : match[2]);
  }
  return path;
};

/** Fields the server owns: never reported as user changes. */
const IGNORED_PATHS = [
  ["metadata", "managedFields"],
  ["metadata", "resourceVersion"],
  ["metadata", "generation"],
  ["metadata", "uid"],
  ["metadata", "creationTimestamp"],
  ["status"],
];

const isIgnored = (path: Path) =>
  IGNORED_PATHS.some(
    (ignored) =>
      path.length >= ignored.length && ignored.every((seg, i) => path[i] === seg)
  );

/**
 * Structural changes from `before` to `after`. Maps recurse per key; arrays
 * recurse per index when the length is unchanged and are compared whole
 * otherwise (a resized container list is one change, not dozens).
 */
export function diffObjects(
  before: unknown,
  after: unknown,
  options: { includeServerFields?: boolean } = {},
  path: Path = []
): Change[] {
  if (!options.includeServerFields && path.length && isIgnored(path)) return [];
  if (deepEqual(before, after)) return [];

  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: Change[] = [];
    for (const key of keys) {
      const sub = [...path, key];
      if (!(key in after)) {
        if (options.includeServerFields || !isIgnored(sub)) {
          changes.push({ path: sub, type: "removed", before: before[key] });
        }
      } else if (!(key in before)) {
        if (options.includeServerFields || !isIgnored(sub)) {
          changes.push({ path: sub, type: "added", after: after[key] });
        }
      } else {
        changes.push(...diffObjects(before[key], after[key], options, sub));
      }
    }
    return changes;
  }

  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((item, i) =>
      diffObjects(item, after[i], options, [...path, i])
    );
  }

  return [{ path, type: "changed", before, after }];
}

/** One-line rendering of a value for change chips. */
export const previewValue = (value: unknown, max = 40): string => {
  let text: string;
  if (value === undefined) text = "∅";
  else if (typeof value === "string") text = value;
  else if (isObject(value)) text = `{${Object.keys(value).length} keys}`;
  else if (Array.isArray(value)) text = `[${value.length} items]`;
  else text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Line counts of a text diff, for the "+N −M" summary. */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence on lines; manifests are small (< few k lines).
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return { added: Math.max(0, m - n), removed: Math.max(0, n - m) };
  }
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[m];
  return { added: m - common, removed: n - common };
}

/* ----------------------------------------------------------- rebasing -- */

const getIn = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, seg) => (node && typeof node === "object" ? (node as any)[seg] : undefined),
    value
  );

export interface RebaseResult {
  /** `theirs` text with the user's edits applied (formatting kept). */
  text: string;
  /** Paths the user changed that also changed on the server (user wins). */
  conflicts: Path[];
  changes: Change[];
}

/**
 * Re-applies the edits made from `baseText` to `mineText` onto `theirsText`
 * (the object as it is on the cluster now). Edits are replayed through the
 * `yaml` document model, so untouched parts of `theirsText` keep their
 * formatting and the review diff only shows the user's changes.
 */
export function rebaseEdits(
  baseText: string,
  mineText: string,
  theirsText: string
): RebaseResult {
  const base = parseDocument(baseText).toJS();
  const mine = parseDocument(mineText).toJS();
  const theirsDoc = parseDocument(theirsText);
  const theirs = theirsDoc.toJS();

  const changes = diffObjects(base, mine);
  const conflicts: Path[] = [];
  for (const change of changes) {
    const remote = getIn(theirs, change.path);
    const original = getIn(base, change.path);
    if (!deepEqual(remote, original) && !deepEqual(remote, change.after)) {
      conflicts.push(change.path);
    }
    if (change.type === "removed") {
      theirsDoc.deleteIn(change.path);
    } else {
      theirsDoc.setIn(change.path, theirsDoc.createNode(change.after));
    }
  }

  return { text: theirsDoc.toString(), conflicts, changes };
}

/** `text` with `metadata.resourceVersion` replaced (formatting kept). */
export function withResourceVersion(text: string, resourceVersion: string): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return text;
  doc.setIn(["metadata", "resourceVersion"], resourceVersion);
  return doc.toString();
}

export function readResourceVersion(text: string): string | null {
  try {
    const value = parseDocument(text).getIn(["metadata", "resourceVersion"]);
    return value === undefined || value === null ? null : String(value);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- error mapping -- */

export interface ApplyProblem {
  message: string;
  path?: Path;
  /** 1-based line in the submitted YAML, when it could be located. */
  line?: number;
}

export type ConflictKind = "conflict" | "notFound" | "alreadyExists" | null;

export function classifyError(message: string): ConflictKind {
  if (
    /\(Conflict\)|the object has been modified|please apply your changes to the latest version/i.test(
      message
    )
  ) {
    return "conflict";
  }
  if (/\(AlreadyExists\)|already exists/i.test(message)) return "alreadyExists";
  if (/\(NotFound\)/.test(message)) return "notFound";
  return null;
}

const FIELD_PATH = String.raw`[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[[^\]\s]*\])*`;

/** Splits the API's aggregated `[a, b, c]` field error list. */
function splitAggregate(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [trimmed];
  const inner = trimmed.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (c === "," && depth === 0 && inner[i + 1] === " " && new RegExp(`^ ${FIELD_PATH}: `).test(inner.slice(i + 1))) {
      parts.push(inner.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Turns kubectl / API server error output (dry run or real) into individual
 * problems, extracting field paths or YAML line numbers where present.
 */
export function parseApplyErrors(output: string): ApplyProblem[] {
  const problems: ApplyProblem[] = [];
  const text = output.replace(/\r/g, "").trim();
  if (!text) return problems;

  const add = (message: string, path?: Path, line?: number) => {
    const clean = message.trim().replace(/^\*\s*/, "");
    if (!clean) return;
    if (problems.some((p) => p.message === clean && formatPath(p.path || []) === formatPath(path || []))) return;
    problems.push({ message: clean, ...(path && path.length ? { path } : {}), ...(line ? { line } : {}) });
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^Warning:/i.test(line)) continue;

    // YAML syntax errors: "yaml: line 12: mapping values are not allowed"
    const yamlLine = /yaml: line (\d+): (.*)$/.exec(line);
    if (yamlLine) {
      add(`YAML: ${yamlLine[2]}`, undefined, Number(yamlLine[1]));
      continue;
    }

    // Strict decoding: unknown field "spec.foo", duplicate field "x"
    const fieldRe = /(unknown|duplicate) field "([^"]+)"/g;
    let fieldMatch: RegExpExecArray | null;
    let sawField = false;
    while ((fieldMatch = fieldRe.exec(line))) {
      sawField = true;
      add(`${fieldMatch[1] === "unknown" ? "Unknown" : "Duplicate"} field "${fieldMatch[2]}"`, parseFieldPath(fieldMatch[2]));
    }
    if (sawField) continue;

    // json: cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of type int32
    const unmarshal = /cannot unmarshal (\w+) into Go struct field \w+\.(\S+) of type (\S+)/.exec(line);
    if (unmarshal) {
      add(`Expected ${unmarshal[3]}, got ${unmarshal[1]} at ${unmarshal[2]}`, parseFieldPath(unmarshal[2]));
      continue;
    }

    // The Deployment "x" is invalid: [a: ..., b: ...] / a: ...
    const invalid = /is invalid: (.*)$/.exec(line);
    if (invalid) {
      for (const item of splitAggregate(invalid[1])) {
        const field = new RegExp(`^(${FIELD_PATH}): (.*)$`).exec(item);
        if (field) add(`${field[1]}: ${field[2]}`, parseFieldPath(field[1]));
        else add(item);
      }
      continue;
    }

    // "* spec.replicas: Invalid value" continuation lines
    const bullet = new RegExp(`^\\*\\s+(${FIELD_PATH}): (.*)$`).exec(line);
    if (bullet) {
      add(`${bullet[1]}: ${bullet[2]}`, parseFieldPath(bullet[1]));
      continue;
    }

    add(
      line
        .replace(/^error: /, "")
        .replace(/^Error from server(?: \((\w+)\))?: (error when \w+ "STDIN": )?/, (_, reason) =>
          reason ? `${reason}: ` : ""
        )
    );
  }
  return problems;
}

/** Offset -> 1-based line (and column) lookup for a YAML text. */
function lineOf(counter: LineCounter, offset: number) {
  const { line, col } = counter.linePos(offset);
  return { line, column: col };
}

/**
 * Locates `path` in a YAML text: the key line of the deepest existing
 * segment (a missing "Required value" field points at its parent).
 */
export function locatePath(
  text: string,
  path: Path
): { line: number; column: number; exact: boolean } | null {
  const counter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, { lineCounter: counter, keepSourceTokens: false });
  } catch {
    return null;
  }

  let node: YamlNode | null = doc.contents as YamlNode | null;
  let found: { line: number; column: number } | null = null;
  let depth = 0;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => {
        const key = isScalar(p.key) ? p.key.value : p.key;
        return String(key) === String(seg);
      });
      if (!pair) break;
      const keyNode = pair.key as YamlNode | null;
      if (keyNode?.range) found = lineOf(counter, keyNode.range[0]);
      node = pair.value as YamlNode | null;
    } else if (isSeq(node) && typeof seg === "number") {
      const item = node.items[seg] as YamlNode | undefined;
      if (!item) break;
      if (item.range) found = lineOf(counter, item.range[0]);
      node = item;
    } else {
      break;
    }
    depth++;
  }
  return found ? { ...found, exact: depth === path.length } : null;
}

/** Fills in `line` for problems that carry a field path. */
export function locateProblems(text: string, problems: ApplyProblem[]): ApplyProblem[] {
  return problems.map((problem) => {
    if (problem.line || !problem.path) return problem;
    const location = locatePath(text, problem.path);
    return location ? { ...problem, line: location.line } : problem;
  });
}

/* ---------------------------------------------------- cross-context diff */

const NOISY_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
];

/**
 * Drops cluster-assigned fields (uid, resourceVersion, timestamps, managed
 * fields, status...) so two clusters' copies of an object compare on what
 * was declared.
 */
export function stripServerFields(object: any, options: { keepStatus?: boolean } = {}): any {
  if (!isObject(object)) return object;
  const out: any = { ...object };
  if (!options.keepStatus) delete out.status;
  if (isObject(out.metadata)) {
    const metadata: any = { ...out.metadata };
    for (const key of [
      "uid",
      "resourceVersion",
      "creationTimestamp",
      "generation",
      "managedFields",
      "selfLink",
    ]) {
      delete metadata[key];
    }
    if (isObject(metadata.annotations)) {
      const annotations = { ...metadata.annotations };
      for (const key of NOISY_ANNOTATIONS) delete annotations[key];
      if (Object.keys(annotations).length) metadata.annotations = annotations;
      else delete metadata.annotations;
    }
    out.metadata = metadata;
  }
  return out;
}
