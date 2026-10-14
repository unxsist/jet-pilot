/*
 * Which objects a custom action applies to (pure, unit tested): kinds,
 * namespace and context globs, a label selector, and whether it runs on
 * several selected objects at once. Plus the scope in words for the
 * settings list ("Pods and deployments in prod-*").
 */
import { formatResourceKind as pluralize } from "@/lib/utils";
import type { ActionScope, CustomAction } from "./types";

/* -------------------------------------------------------------- globs -- */

const globCache = new Map<string, RegExp>();
const globRegExp = (glob: string): RegExp => {
  let regexp = globCache.get(glob);
  if (!regexp) {
    const source = glob
      .split("")
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    regexp = new RegExp(`^${source}$`, "i");
    if (globCache.size > 500) globCache.clear();
    globCache.set(glob, regexp);
  }
  return regexp;
};

/**
 * `value` matches the globs: no globs match everything; `!glob` excludes.
 * With only exclusions, everything else matches.
 */
export function matchesGlobs(globs: readonly string[], value: string): boolean {
  if (globs.length === 0) return true;
  const include = globs.filter((glob) => !glob.startsWith("!"));
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (exclude.some((glob) => globRegExp(glob).test(value))) return false;
  return include.length === 0 || include.some((glob) => globRegExp(glob).test(value));
}

/* ----------------------------------------------------- label selector -- */

export type Requirement =
  | { key: string; op: "=" | "!="; values: [string] }
  | { key: string; op: "in" | "notin"; values: string[] }
  | { key: string; op: "exists" | "!exists"; values: [] };

const KEY = String.raw`[A-Za-z0-9]([-A-Za-z0-9_./]*[A-Za-z0-9])?`;
const VALUE = String.raw`([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?`;
const KEY_RE = new RegExp(`^${KEY}$`);
const VALUE_RE = new RegExp(`^${VALUE}$`);

/* Splits on commas outside parentheses. */
const splitRequirements = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
};

/** Parses a Kubernetes label selector; a string is the reason it isn't one. */
export function parseSelector(text: string): Requirement[] | string {
  const requirements: Requirement[] = [];
  for (const part of splitRequirements(text)) {
    let match: RegExpExecArray | null;
    if ((match = /^!\s*(\S+)$/.exec(part))) {
      if (!KEY_RE.test(match[1]!)) return `"${match[1]}" isn't a label key`;
      requirements.push({ key: match[1]!, op: "!exists", values: [] });
    } else if ((match = /^(\S+?)\s*(==|!=|=)\s*(\S*)$/.exec(part))) {
      const [, key, op, value] = match;
      if (!KEY_RE.test(key!)) return `"${key}" isn't a label key`;
      if (!VALUE_RE.test(value!)) return `"${value}" isn't a label value`;
      requirements.push({ key: key!, op: op === "!=" ? "!=" : "=", values: [value!] });
    } else if ((match = /^(\S+)\s+(in|notin)\s*\(([^)]*)\)$/.exec(part))) {
      const [, key, op, list] = match;
      if (!KEY_RE.test(key!)) return `"${key}" isn't a label key`;
      const values = list!.split(",").map((value) => value.trim());
      const invalid = values.find((value) => !VALUE_RE.test(value));
      if (invalid !== undefined) return `"${invalid}" isn't a label value`;
      requirements.push({ key: key!, op: op as "in" | "notin", values });
    } else if (KEY_RE.test(part)) {
      requirements.push({ key: part, op: "exists", values: [] });
    } else {
      return `"${part}" isn't a label selector requirement (like app=web, tier in (api,worker) or !canary)`;
    }
  }
  return requirements;
}

export function matchesSelector(
  requirements: readonly Requirement[],
  labels: Record<string, string> | undefined | null
): boolean {
  return requirements.every((requirement) => {
    const has = !!labels && Object.prototype.hasOwnProperty.call(labels, requirement.key);
    const value = has ? labels![requirement.key] : undefined;
    switch (requirement.op) {
      case "=":
        return has && value === requirement.values[0];
      case "!=":
        return !has || value !== requirement.values[0];
      case "in":
        return has && requirement.values.includes(value!);
      case "notin":
        return !has || !requirement.values.includes(value!);
      case "exists":
        return has;
      case "!exists":
        return !has;
    }
  });
}

/* -------------------------------------------------------------- kinds -- */

/** An object a custom action may run on (a table row or the side panel's object). */
export interface ScopeObject {
  kind?: string;
  apiVersion?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    context?: string;
  };
}

const groupOf = (apiVersion = "") => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");

/** `Pod`, `pod`, or `Application.argoproj.io` (kind plus API group). */
export function matchesKind(kinds: readonly string[], object: ScopeObject): boolean {
  if (kinds.length === 0) return true;
  const kind = (object.kind ?? "").toLowerCase();
  const group = groupOf(object.apiVersion).toLowerCase();
  return kinds.some((entry) => {
    const [name, ...rest] = entry.trim().toLowerCase().split(".");
    if (name === "*") return true;
    if (name !== kind) return false;
    return rest.length === 0 || rest.join(".") === group;
  });
}

/* Kinds `exec` can open a shell in (kubectl exec resolves workloads to a pod). */
export const EXEC_KINDS = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"];

const selectorCache = new Map<string, Requirement[] | string>();
const selectorOf = (text: string) => {
  let parsed = selectorCache.get(text);
  if (parsed === undefined) {
    parsed = parseSelector(text);
    if (selectorCache.size > 200) selectorCache.clear();
    selectorCache.set(text, parsed);
  }
  return parsed;
};

/** The action applies to `object` (fetched from `context`). */
export function matchesScope(action: Pick<CustomAction, "scope" | "run">, object: ScopeObject, context?: string): boolean {
  const { scope } = action;
  if (!object?.kind || !object.metadata?.name) return false;
  if (!matchesKind(scope.kinds, object)) return false;
  if (action.run.type === "exec" && !EXEC_KINDS.includes(object.kind)) return false;
  if (scope.namespaces.length && !matchesGlobs(scope.namespaces, object.metadata.namespace ?? "")) return false;
  const ctx = context ?? object.metadata.context ?? "";
  if (scope.contexts.length && !matchesGlobs(scope.contexts, ctx)) return false;
  if (scope.labels.trim()) {
    const requirements = selectorOf(scope.labels);
    if (typeof requirements === "string") return false;
    if (!matchesSelector(requirements, object.metadata.labels)) return false;
  }
  return true;
}

/** The action applies to all of `objects` (one, or several when `multiple`). */
export function matchesAll(action: Pick<CustomAction, "scope" | "run">, objects: readonly ScopeObject[]): boolean {
  if (objects.length === 0) return false;
  if (objects.length > 1 && !action.scope.multiple) return false;
  return objects.every((object) => matchesScope(action, object));
}

/* ------------------------------------------------------------- words -- */

/** "StatefulSet" → "stateful sets", "Pod" → "pods". */
export function kindWords(kind: string, count = 2): string {
  const [name] = kind.split(".");
  const words = (name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return count === 1 ? words : pluralize(words);
}

const listWords = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const globWords = (globs: string[], preposition: "in" | "on"): string => {
  const include = globs.filter((glob) => !glob.startsWith("!"));
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const parts: string[] = [];
  if (include.length) parts.push(`${preposition} ${listWords(include)}`);
  if (exclude.length) parts.push(`not ${preposition} ${listWords(exclude)}`);
  return parts.join(", ");
};

/** The scope in words: "Pods and deployments in prod-* · on staging · several at once". */
export function describeScope(scope: ActionScope): string {
  const kinds = scope.kinds.filter((kind) => kind !== "*");
  let subject =
    kinds.length === 0 || kinds.length < scope.kinds.length
      ? "Any object"
      : capitalize(listWords(kinds.map((kind) => kindWords(kind))));
  if (scope.namespaces.length) subject += ` ${globWords(scope.namespaces, "in")}`;
  if (scope.labels.trim()) subject += ` with ${scope.labels.trim()}`;
  const parts = [subject];
  if (scope.contexts.length) parts.push(globWords(scope.contexts, "on"));
  if (scope.multiple) parts.push("several at once");
  return parts.join(" · ");
}
