/*
 * Inline edits of labels, annotations and node taints (pure, unit tested):
 * validation in the API server's own terms, said plainly, the change as a
 * reviewable list, and the patch that applies it.
 *
 * Adding and changing keys is a JSON merge patch. Removing keys is a JSON
 * patch (keys with `/` escaped as `~1`) that first tests the values it
 * read, so an edit never overwrites someone else's change to the same key:
 * the server rejects it and the panel shows the fresh state.
 */

export type MetadataField = "labels" | "annotations";

/* DNS-1123 subdomain (a key's prefix) and the name part of a qualified name. */
const DNS_LABEL = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";
const DNS_SUBDOMAIN = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})*$`);
const QUALIFIED_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const NAME_CHARS = "Use letters, digits, '-', '_' or '.', starting and ending with a letter or digit";

/**
 * Checks a label or annotation key (`[prefix/]name`); returns what is
 * wrong, or null.
 */
export function validateKey(key: string): string | null {
  if (!key) return "Enter a key";
  if (/\s/.test(key)) return "Keys can't contain spaces";
  const slash = key.lastIndexOf("/");
  const prefix = slash >= 0 ? key.slice(0, slash) : "";
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  if (slash >= 0) {
    if (!prefix) return "The prefix before '/' can't be empty";
    if (prefix.includes("/")) return "A key has at most one '/'";
    if (prefix.length > 253) return "The prefix can be 253 characters at most";
    if (!DNS_SUBDOMAIN.test(prefix)) return "The prefix must be a lowercase DNS name, like example.com";
  }
  if (!name) return "Enter a name after the '/'";
  if (name.length > 63) return "The name can be 63 characters at most (the prefix doesn't count)";
  if (!QUALIFIED_NAME.test(name)) return NAME_CHARS;
  return null;
}

/** Checks a label value (annotation values can be anything). */
export function validateLabelValue(value: string): string | null {
  if (value === "") return null;
  if (value.length > 63) return "Label values can be 63 characters at most";
  if (!QUALIFIED_NAME.test(value)) return `${NAME_CHARS}, or leave it empty`;
  return null;
}

/** All annotations of an object together: 256 KiB at most. */
export const ANNOTATIONS_LIMIT = 256 * 1024;

export function annotationsSize(entries: Record<string, string>): number {
  const encoder = new TextEncoder();
  let size = 0;
  for (const [key, value] of Object.entries(entries)) size += encoder.encode(key).length + encoder.encode(value).length;
  return size;
}

/* ---------------------------------------------------------- changes -- */

export interface EntryChange {
  type: "add" | "change" | "remove";
  key: string;
  before?: string;
  after?: string;
}

/** What turns `before` into `after`, in key order. */
export function diffEntries(before: Record<string, string>, after: Record<string, string>): EntryChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: EntryChange[] = [];
  for (const key of keys) {
    const has = Object.prototype.hasOwnProperty;
    const was = has.call(before, key);
    const is = has.call(after, key);
    if (was && !is) changes.push({ type: "remove", key, before: before[key] });
    else if (!was && is) changes.push({ type: "add", key, after: after[key] });
    else if (before[key] !== after[key]) changes.push({ type: "change", key, before: before[key], after: after[key] });
  }
  return changes;
}

/** A JSON Pointer segment (RFC 6901): `~` → `~0`, `/` → `~1`. */
export const pointerSegment = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

export type JsonPatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type Patch =
  | { type: "merge"; body: Record<string, unknown> }
  | { type: "json"; body: JsonPatchOp[] };

/**
 * The patch for label / annotation changes: a merge patch for additions
 * and changes, a JSON patch (testing the values it read) once a key is
 * removed. Null when nothing changed.
 */
export function metadataPatch(field: MetadataField, changes: EntryChange[]): Patch | null {
  if (changes.length === 0) return null;
  if (!changes.some((change) => change.type === "remove")) {
    const entries = Object.fromEntries(changes.map((change) => [change.key, change.after ?? ""]));
    return { type: "merge", body: { metadata: { [field]: entries } } };
  }
  const base = `/metadata/${field}`;
  const ops: JsonPatchOp[] = [];
  for (const change of changes) {
    const path = `${base}/${pointerSegment(change.key)}`;
    // A removal means the field exists: additions can go straight in.
    if (change.type === "add") {
      ops.push({ op: "add", path, value: change.after ?? "" });
    } else {
      ops.push({ op: "test", path, value: change.before ?? "" });
      ops.push(
        change.type === "remove" ? { op: "remove", path } : { op: "replace", path, value: change.after ?? "" }
      );
    }
  }
  return { type: "json", body: ops };
}

/* ----------------------------------------------------------- taints -- */

export type TaintEffect = "NoSchedule" | "PreferNoSchedule" | "NoExecute";
export const TAINT_EFFECTS: TaintEffect[] = ["NoSchedule", "PreferNoSchedule", "NoExecute"];

export interface Taint {
  key: string;
  value?: string;
  effect: TaintEffect | string;
  timeAdded?: string;
}

export const TAINT_EFFECT_WORDS: Record<TaintEffect, string> = {
  NoSchedule: "New pods aren't scheduled here",
  PreferNoSchedule: "New pods avoid this node when they can",
  NoExecute: "Pods without a toleration are evicted, running ones too",
};

/*
 * Taints Kubernetes sets and removes itself (cordon, not-ready, pressure,
 * cloud provider initialisation): shown, not edited.
 */
export const isSystemTaint = (taint: Pick<Taint, "key">) =>
  /^node\.(kubernetes\.io|cloudprovider\.kubernetes\.io)\//.test(taint.key);

/** What is wrong with a taint in a list (key + effect must be unique), or null. */
export function validateTaint(taint: Taint, others: Taint[]): string | null {
  const keyProblem = validateKey(taint.key);
  if (keyProblem) return keyProblem;
  const valueProblem = validateLabelValue(taint.value ?? "");
  if (valueProblem) return valueProblem.replace("Label values", "Values");
  if (!TAINT_EFFECTS.includes(taint.effect as TaintEffect)) return "Choose an effect";
  if (others.some((other) => other.key === taint.key && other.effect === taint.effect)) {
    return `There is already a ${taint.effect} taint with this key`;
  }
  return null;
}

export const taintId = (taint: Taint) => `${taint.key}:${taint.effect}`;
export const formatTaint = (taint: Taint) =>
  `${taint.key}${taint.value ? `=${taint.value}` : ""}:${taint.effect}`;

/** Added / changed / removed taints, keyed by key + effect. */
export function diffTaints(before: Taint[], after: Taint[]): EntryChange[] {
  const map = (list: Taint[]) => Object.fromEntries(list.map((t) => [taintId(t), t.value ?? ""]));
  return diffEntries(map(before), map(after));
}

/**
 * The taints as a JSON patch that first tests the list it read (taints are
 * one array: a merge patch would silently replace a concurrent change).
 */
export function taintsPatch(before: Taint[] | undefined, after: Taint[]): JsonPatchOp[] | null {
  const clean = (list: Taint[]) =>
    list.map((t) => ({ key: t.key, ...(t.value ? { value: t.value } : {}), effect: t.effect, ...(t.timeAdded ? { timeAdded: t.timeAdded } : {}) }));
  if (diffTaints(before ?? [], after).length === 0) return null;
  const ops: JsonPatchOp[] = [];
  if (before) ops.push({ op: "test", path: "/spec/taints", value: before });
  if (after.length === 0) {
    if (before) ops.push({ op: "remove", path: "/spec/taints" });
  } else {
    ops.push({ op: before ? "replace" : "add", path: "/spec/taints", value: clean(after) });
  }
  return ops;
}

/* ----------------------------------------------------------- errors -- */

/**
 * An API error in a sentence: a failed test (someone else changed it), a
 * conflict, forbidden, or the server's message without its noise.
 */
export function editErrorMessage(error: unknown, what: string): string {
  const e = error as { code?: number; message?: string; reason?: string } | string;
  const message = typeof e === "string" ? e : (e?.message ?? String(error));
  const code = typeof e === "object" ? e?.code : undefined;
  if (code === 409 || /the object has been modified/i.test(message)) {
    return `The ${what} changed while you were editing. They're up to date now: check and save again.`;
  }
  if (code === 422 && /test/i.test(message)) {
    return `The ${what} changed while you were editing. They're up to date now: check and save again.`;
  }
  if (code === 403 || /forbidden/i.test(message)) {
    return `You don't have permission to change the ${what} of this object.`;
  }
  const trimmed = message
    .replace(/^.*?(is invalid|admission webhook .*? denied the request):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}…` : trimmed || `Couldn't save the ${what}.`;
}
