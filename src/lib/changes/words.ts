/*
 * Changes in plain words: field changes ("image api:1.4.2 → api:1.5.0",
 * "memory limit 256Mi → 512Mi", "env LOG_LEVEL changed"), what a field
 * manager owns ("changed replicas"), events, restarts, node conditions,
 * Helm and GitOps revisions, and who made a change ("kubectl edit"). Each
 * phrase also has a sentence ("Image changed from api:1.4.2 to
 * api:1.5.0") for `likelyCause`. Pure.
 *
 * Values that may be secret are never put in words: env values and Helm
 * values are named, not shown.
 */
import { listWords, plural } from "@/lib/resources/format";
import type { FieldChange } from "./fields";

export interface Phrase {
  /** Lower case, for a row: "image api:1.4.2 → api:1.5.0". */
  text: string;
  /** For a sentence: "Image changed from api:1.4.2 to api:1.5.0". */
  sentence: string;
}

const phrase = (text: string, sentence = text.charAt(0).toUpperCase() + text.slice(1)): Phrase => ({ text, sentence });

/** "serviceAccountName" -> "service account name". */
export const humanize = (key: string) =>
  key
    .replace(/^\[|\]$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]/g, " ")
    .toLowerCase();

const unbracket = (segment: string) => segment.replace(/^\[|\]$/g, "");

const text = (value: unknown) =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);

/** "ghcr.io/acme/api:1.5.0" -> "api:1.5.0"; digests keep 7 characters. */
export function shortImage(image: unknown): string {
  const value = text(image);
  const [name, digest] = value.split("@");
  const base = name.slice(name.lastIndexOf("/") + 1);
  return digest ? `${base}@${digest.replace(/^sha256:/, "").slice(0, 7)}` : base;
}

/** A git revision, short: "main@sha1:4f1e2d3c…" -> "main@4f1e2d3", a bare sha -> 7 characters. */
export function shortRevision(revision: unknown): string {
  const value = text(revision);
  const match = /^(.*?)@?(?:sha1|sha256):([0-9a-f]{7,})$/.exec(value);
  if (match) return match[1] ? `${match[1]}@${match[2].slice(0, 7)}` : match[2].slice(0, 7);
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
}

const arrow = (from: unknown, to: unknown) => `${text(from)} → ${text(to)}`;

/* The ConfigMaps and Secrets an envFrom list refers to: "ConfigMap a". */
const envFromRefs = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).flatMap((item: any) => [
    ...(item?.configMapRef?.name ? [`ConfigMap ${item.configMapRef.name}`] : []),
    ...(item?.secretRef?.name ? [`Secret ${item.secretRef.name}`] : []),
  ]);

const taintKeys = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).map((t: any) => String(t?.key ?? "")).filter(Boolean);

const PROBES: Record<string, string> = {
  readinessProbe: "readiness probe",
  livenessProbe: "liveness probe",
  startupProbe: "startup probe",
};

function containerPhrase(container: string, rest: string[], field: FieldChange): Phrase | null {
  const { from, to } = field;
  if (rest.length === 0) {
    if (from === undefined) return phrase(`container ${container} added`);
    if (to === undefined) return phrase(`container ${container} removed`);
    return phrase(`container ${container} changed`);
  }
  const [key, ...more] = rest;
  if (key === "image") {
    if (from === undefined) return phrase(`image ${shortImage(to)}`, `Image set to ${shortImage(to)}`);
    return phrase(
      `image ${shortImage(from)} → ${shortImage(to)}`,
      `Image changed from ${shortImage(from)} to ${shortImage(to)}`
    );
  }
  if (key === "env") {
    if (!more.length) return phrase("env changed", "Environment variables changed");
    const name = unbracket(more[0]);
    if (more.length === 1 && from === undefined) return phrase(`env ${name} added`, `Environment variable ${name} added`);
    if (more.length === 1 && to === undefined) return phrase(`env ${name} removed`, `Environment variable ${name} removed`);
    const source = more.includes("secretKeyRef") ? "Secret" : more.includes("configMapKeyRef") ? "ConfigMap" : "";
    if (source && more[more.length - 1] === "name" && to !== undefined) {
      return phrase(`env ${name} from ${source} ${text(to)}`, `${name} now comes from ${source} ${text(to)}`);
    }
    return phrase(`env ${name} changed`, `Environment variable ${name} changed`);
  }
  if (key === "envFrom") {
    const before = envFromRefs(from);
    const after = envFromRefs(to);
    const added = after.filter((r) => !before.includes(r));
    const removed = before.filter((r) => !after.includes(r));
    if (added.length === 1 && removed.length === 1 && added[0].split(" ")[0] === removed[0].split(" ")[0]) {
      const [kind, next] = added[0].split(" ");
      const previous = removed[0].split(" ")[1];
      return phrase(`${kind} ${previous} → ${next}`, `Switched from ${kind} ${previous} to ${next}`);
    }
    if (added.length) return phrase(`uses ${listWords(added)}`, `Now uses ${listWords(added)}`);
    if (removed.length) return phrase(`stops using ${listWords(removed)}`, `No longer uses ${listWords(removed)}`);
    return phrase("env sources changed", "Environment sources changed");
  }
  if (key === "resources") {
    if (more.length === 2) {
      const [kind, resource] = more;
      const what = `${resource} ${kind === "limits" ? "limit" : "request"}`;
      if (from === undefined) return phrase(`${what} ${text(to)}`, `${what.charAt(0).toUpperCase()}${what.slice(1)} set to ${text(to)}`);
      if (to === undefined) return phrase(`${what} removed`);
      return phrase(`${what} ${arrow(from, to)}`, `${what.charAt(0).toUpperCase()}${what.slice(1)} changed from ${text(from)} to ${text(to)}`);
    }
    return phrase("resources changed");
  }
  if (PROBES[key]) return phrase(`${PROBES[key]} changed`);
  if (key === "command" || key === "args") return phrase(key === "command" ? "command changed" : "arguments changed");
  return phrase(`${humanize(key)} changed`);
}

const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";

/** A `kubectl rollout restart`: the annotation itself, or annotations that gained or moved it. */
export function isRestart(field: FieldChange): boolean {
  if (field.path.includes(RESTARTED_AT)) return true;
  const stamp = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>)[RESTARTED_AT] : undefined);
  return field.path[field.path.length - 1] === "annotations" && stamp(field.to) !== undefined && stamp(field.to) !== stamp(field.from);
}

/** One field change in words. */
export function fieldPhrase(field: FieldChange): Phrase {
  const path = field.path;
  const { from, to } = field;
  const last = path[path.length - 1] ?? "";

  if (isRestart(field)) return phrase("restarted", "Restarted");

  const ci = path.findIndex((s) => s === "containers" || s === "initContainers" || s === "ephemeralContainers");
  if (ci >= 0 && path[ci + 1]) {
    const found = containerPhrase(unbracket(path[ci + 1]), path.slice(ci + 2), field);
    if (found) return found;
  }

  const vi = path.indexOf("volumes");
  if (vi >= 0 && path[vi + 1]) {
    const volume = unbracket(path[vi + 1]);
    const rest = path.slice(vi + 2);
    if (rest.includes("configMap") && last === "name" && from !== undefined && to !== undefined) {
      return phrase(`ConfigMap ${arrow(from, to)}`, `Switched from ConfigMap ${text(from)} to ${text(to)}`);
    }
    if (rest.includes("secret") && last === "secretName" && from !== undefined && to !== undefined) {
      return phrase(`Secret ${arrow(from, to)}`, `Switched from Secret ${text(from)} to ${text(to)}`);
    }
    if (!rest.length) return phrase(`volume ${volume} ${from === undefined ? "added" : to === undefined ? "removed" : "changed"}`);
    return phrase(`volume ${volume} changed`);
  }

  if (path.length === 1 && last === "replicas") {
    if (from === undefined || to === undefined) return phrase("replicas changed");
    return phrase(`replicas ${arrow(from, to)}`, `Scaled from ${text(from)} to ${text(to)} replicas`);
  }
  if (last === "paused") return to === true ? phrase("rollout paused") : phrase("rollout resumed");
  if (last === "unschedulable") return to === true ? phrase("cordoned") : phrase("uncordoned");
  if (last === "taints") {
    // A cordon adds this taint itself: "cordoned" says it.
    const cordon = (k: string) => k !== "node.kubernetes.io/unschedulable";
    const added = taintKeys(to).filter((k) => !taintKeys(from).includes(k)).filter(cordon);
    const removed = taintKeys(from).filter((k) => !taintKeys(to).includes(k)).filter(cordon);
    if (!added.length && !removed.length && taintKeys(to).length !== taintKeys(from).length) {
      return taintKeys(to).length > taintKeys(from).length ? phrase("cordoned") : phrase("uncordoned");
    }
    if (added.length && !removed.length) return phrase(`taint ${listWords(added)} added`);
    if (removed.length && !added.length) return phrase(`taint ${listWords(removed)} removed`);
    return phrase("taints changed");
  }
  // A pod template's own metadata (`template.metadata` in a spec, `metadata` in a template).
  const mi = path[0] === "template" ? 1 : 0;
  if (path[mi] === "metadata") return phrase(path[mi + 1] === "annotations" ? "pod annotations changed" : "pod labels changed");
  if (last === "strategy" || last === "updateStrategy" || path.includes("strategy") || path.includes("updateStrategy")) {
    return phrase("update strategy changed");
  }
  const named = [...path].reverse().find((s) => !/^\[.*\]$/.test(s) && s !== "spec" && s !== "template") ?? "spec";
  return phrase(`${humanize(named)} changed`);
}

/** Several phrases as one: the first two, then "and 3 more". */
export function joinPhrases(phrases: Phrase[], more = false): Phrase {
  const unique = phrases.filter((p, i) => phrases.findIndex((q) => q.text === p.text) === i);
  if (!unique.length) return phrase("changed and changed back");
  const shown = unique.slice(0, 2);
  const rest = unique.length - shown.length;
  const tail = rest > 0 || more ? ` and ${rest > 0 ? rest : "some"} more` : "";
  return {
    text: `${shown.map((p) => p.text).join(", ")}${tail}`,
    sentence: `${shown.map((p, i) => (i === 0 ? p.sentence : p.text)).join(", ")}${tail}`,
  };
}

/** Field changes in words. */
export const fieldWords = (fields: FieldChange[], more = false) => joinPhrases(fields.map(fieldPhrase), more);

/** Which keys of a ConfigMap or Secret changed (never their values). */
export function keyWords(kind: string, name: string, keys: { added?: string[]; removed?: string[]; changed?: string[] }): Phrase {
  const all = [...(keys.changed ?? []), ...(keys.added ?? []), ...(keys.removed ?? [])];
  const what = all.length > 3 ? plural(all.length, "key") : listWords(all);
  const verb =
    (keys.added?.length ?? 0) === all.length ? "added" : (keys.removed?.length ?? 0) === all.length ? "removed" : "changed";
  if (!all.length) return phrase("edited", `${kind} ${name} was edited`);
  return { text: `${what} ${verb}`, sentence: `${kind} ${name}: ${what} ${verb}` };
}

/* --------------------------------------------------------- managers -- */

const MANAGERS: Record<string, string> = {
  kubectl: "kubectl",
  "kubectl-edit": "kubectl edit",
  "kubectl-client-side-apply": "kubectl apply",
  "kubectl-rollout": "kubectl rollout",
  "kubectl-scale": "kubectl scale",
  "kubectl-patch": "kubectl patch",
  "kubectl-set": "kubectl set",
  "kubectl-label": "kubectl label",
  "kubectl-annotate": "kubectl annotate",
  "kubectl-replace": "kubectl replace",
  "kubectl-create": "kubectl create",
  "kubectl-cordon": "kubectl cordon",
  "kubectl-drain": "kubectl drain",
  helm: "Helm",
  "argocd-controller": "Argo CD",
  "argocd-application-controller": "Argo CD",
  "argocd-server": "Argo CD",
  "kustomize-controller": "Flux",
  "helm-controller": "Flux",
  "kube-controller-manager": "Kubernetes",
  "horizontal-pod-autoscaler": "autoscaler",
  "default-scheduler": "scheduler",
  "node-controller": "Kubernetes",
  "cluster-autoscaler": "cluster autoscaler",
  "persistentvolume-controller": "volume controller",
  "attachdetach-controller": "volume controller",
  "terraform-provider-kubernetes": "Terraform",
  "jet-pilot": "JET Pilot",
};

/** Who made a change, for people: "kubectl-edit" -> "kubectl edit". */
export const managerLabel = (manager?: string) => (manager ? MANAGERS[manager] ?? manager : "");

/* ---------------------------------------------------- managed fields -- */

type FieldsV1 = Record<string, any>;

const fieldKey = (key: string) => (key.startsWith("f:") ? key.slice(2) : key);

/* The leaf topics a fieldsV1 tree owns, coarsely: "replicas", "image". */
function topics(tree: FieldsV1 | undefined, path: string[] = [], out = new Set<string>()): Set<string> {
  if (!tree || typeof tree !== "object") return out;
  const keys = Object.keys(tree).filter((k) => k !== ".");
  if (!keys.length) {
    const p = path;
    const last = p[p.length - 1] ?? "";
    if (p.includes("kubectl.kubernetes.io/restartedAt")) out.add("restart");
    else if (p[0] === "metadata") out.add(p[1] === "annotations" ? "annotations" : p[1] === "labels" ? "labels" : "metadata");
    else if (p[0] === "data" || p[0] === "binaryData" || p[0] === "stringData") out.add(`key:${p[1] ?? ""}`);
    else if (p.includes("image")) out.add("image");
    else if (p.includes("env") || p.includes("envFrom")) out.add("env");
    else if (p.includes("resources")) out.add("resources");
    else if (p.some((s) => s in PROBES)) out.add("probes");
    else if (p.length === 2 && p[0] === "spec") out.add(humanize(last));
    else if (p[0] === "spec" && p[1] === "template") out.add("the pod template");
    else out.add(p[0] === "spec" ? "the spec" : humanize(p[0] ?? ""));
    return out;
  }
  for (const key of keys) {
    // k:{"name":"api"} items and v: values belong to their list.
    if (key.startsWith("k:") || key.startsWith("v:")) topics(tree[key], path, out);
    else topics(tree[key], [...path, fieldKey(key)], out);
  }
  return out;
}

/** What a field manager owns, coarsely: "replicas", "image", "key:password", "restart". */
export const ownedTopics = (fieldsV1: FieldsV1 | undefined): string[] => [...topics(fieldsV1)];

/**
 * What a field manager's entry says about its last write: "changed
 * replicas", "restarted", "changed password". Null when it only owns
 * metadata (labels and annotations controllers keep up to date).
 */
export function managedWords(kind: string, fieldsV1: FieldsV1 | undefined): Phrase | null {
  const owned = ownedTopics(fieldsV1);
  const keys = owned.filter((t) => t.startsWith("key:")).map((t) => t.slice(4)).filter(Boolean);
  if (kind === "ConfigMap" || kind === "Secret") {
    if (!keys.length) return null;
    const what = keys.length > 3 ? plural(keys.length, "key") : listWords(keys);
    return { text: `changed ${what}`, sentence: `Changed ${what}` };
  }
  const spec = owned.filter((t) => !["labels", "annotations", "metadata"].includes(t) && !t.startsWith("key:"));
  if (!spec.length) return null;
  if (spec.length === 1 && spec[0] === "restart") return phrase("restarted");
  if (spec.length > 3 || spec.includes("the spec")) return phrase("updated the spec");
  return phrase(`changed ${listWords(spec.filter((t) => t !== "restart"))}`);
}

/* ------------------------------------------------------------ events -- */

const PLAIN_EVENTS: Record<string, string> = {
  NodeNotReady: "not ready",
  NodeReady: "ready again",
  Rebooted: "rebooted",
  RegisteredNode: "joined the cluster",
  RemovingNode: "left the cluster",
  NodeNotSchedulable: "cordoned",
  NodeSchedulable: "uncordoned",
  Preempted: "preempted",
  OOMKilling: "ran out of memory",
};

const firstLine = (message: string, max = 140) => {
  const line = message.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** An event in words: "scaled to 5 (cpu above target)", "Back-off restarting failed container". */
export function eventWords(event: { type?: string; reason?: string; message?: string; count?: number }): Phrase {
  const reason = event.reason ?? "";
  const message = event.message ?? "";
  const times = (event.count ?? 1) > 1 ? ` (${event.count} times)` : "";
  if (reason === "SuccessfulRescale") {
    const match = /New size: (\d+); reason: ([^;]*)/i.exec(message);
    if (match) {
      const why = match[2]
        .replace(/^(\w+) resource utilization \(percentage of request\) above target$/i, "$1 above target")
        .replace(/^(\w+) resource above target$/i, "$1 above target")
        .replace(/^All metrics below target$/i, "all metrics below target");
      return phrase(`scaled to ${match[1]} (${why})`, `Scaled to ${match[1]} replicas (${why})`);
    }
    return phrase("rescaled");
  }
  if (reason === "FailedRescale") {
    const match = /New size: (\d+);.*capped at the maximum of (\d+)/i.exec(message);
    if (match) return phrase(`wants ${match[1]} replicas, capped at ${match[2]}${times}`);
  }
  if (PLAIN_EVENTS[reason]) return phrase(`${PLAIN_EVENTS[reason]}${times}`);
  if (reason === "BackOff" && /restarting failed container/i.test(message)) return phrase(`keeps crashing${times}`);
  const pull = /pull(?:ing)? image "?([^"\s]+)"?/i.exec(message);
  if ((reason === "BackOff" || reason === "Failed") && pull) return phrase(`can't pull image ${shortImage(pull[1])}${times}`);
  if (reason === "FailedScheduling") {
    const match = /nodes are available: (.*?)(?:\. preemption|$)/i.exec(message);
    const why = (match?.[1] ?? "")
      .split(/,\s*/)
      .map((part) => part.replace(/^\d+\s+/, "").replace(/\.$/, "").trim())
      .filter((part, i, all) => part && all.indexOf(part) === i);
    if (why.length) return phrase(`can't be scheduled: ${listWords(why).toLowerCase()}${times}`);
  }
  if (reason === "TriggeredScaleUp") return phrase("triggered a cluster scale-up");
  if (reason === "ScaleDown") return phrase("removed by the cluster autoscaler");
  if (reason === "Evicted") return phrase(`evicted: ${firstLine(message, 100)}`);
  const line = firstLine(message) || humanize(reason);
  return { text: `${line}${times}`, sentence: `${line}${times}` };
}

/* ---------------------------------------------------------- restarts -- */

/** A container's last restart: "restarted after running out of memory". */
export function restartWords(terminated: { reason?: string; exitCode?: number }, restarts: number): Phrase {
  const reason = terminated.reason ?? "";
  const why =
    reason === "OOMKilled"
      ? "after running out of memory"
      : reason === "Error" && terminated.exitCode !== undefined
        ? `after exiting with code ${terminated.exitCode}`
        : reason === "Completed"
          ? "after exiting"
          : reason
            ? `(${humanize(reason)})`
            : "";
  const count = restarts > 1 ? ` · ${restarts} restarts` : "";
  return phrase(`restarted ${why}`.trim() + count);
}

/* -------------------------------------------------------- conditions -- */

const PRESSURE: Record<string, string> = {
  MemoryPressure: "memory",
  DiskPressure: "disk",
  PIDPressure: "process",
};

/** A node condition's transition: "not ready", "under disk pressure". Null when not worth a line. */
export function conditionWords(type: string, status: string): Phrase | null {
  if (type === "Ready") return status === "True" ? phrase("ready again") : phrase("not ready");
  if (PRESSURE[type]) {
    return status === "True" ? phrase(`under ${PRESSURE[type]} pressure`) : phrase(`no longer under ${PRESSURE[type]} pressure`);
  }
  if (type === "NetworkUnavailable") return status === "True" ? phrase("network unavailable") : null;
  return null;
}

/* --------------------------------------------------- Helm and GitOps -- */

export interface HelmRevisionLike {
  revision: number;
  status?: string;
  chart?: string;
  chartVersion?: string;
  description?: string;
  values?: Record<string, unknown>;
}

/** Value paths that differ between two revisions ("image.tag"), not the values. */
export function valuePaths(before: unknown, after: unknown, diff: (a: unknown, b: unknown) => FieldChange[]): string[] {
  return diff(before ?? {}, after ?? {}).map((f) => f.path.map(unbracket).join("."));
}

/** A Helm revision against the one before it. */
export function helmWords(
  previous: HelmRevisionLike | undefined,
  revision: HelmRevisionLike,
  diff: (a: unknown, b: unknown) => FieldChange[]
): Phrase {
  const failed = /failed/i.test(revision.status ?? "");
  const rollback = /^Rollback to (\d+)/i.exec(revision.description ?? "");
  let words: Phrase;
  if (rollback) {
    words = phrase(`rolled back to revision ${rollback[1]}`);
  } else if (!previous) {
    words = phrase(`installed ${revision.chart ?? "the chart"} ${revision.chartVersion ?? ""}`.trim());
  } else {
    const parts: Phrase[] = [];
    if (previous.chartVersion !== revision.chartVersion) {
      parts.push(
        phrase(
          `chart ${previous.chartVersion} → ${revision.chartVersion}`,
          `Chart upgraded from ${previous.chartVersion} to ${revision.chartVersion}`
        )
      );
    }
    const paths = valuePaths(previous.values, revision.values, diff);
    if (paths.length) {
      parts.push(phrase(paths.length > 3 ? `${paths.length} values changed` : `values ${listWords(paths)} changed`));
    }
    words = parts.length ? joinPhrases(parts) : phrase("upgraded, same chart and values");
  }
  return failed ? { text: `${words.text} · failed`, sentence: `${words.sentence}, which failed` } : words;
}
