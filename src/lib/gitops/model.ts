/*
 * GitOps (Flux + Argo CD), the pure part: which kinds are deliveries, what
 * state a delivery is in (from its conditions / status), its source in short
 * form, its resources, sorting, filtering and the page summary. No Vue, so it
 * is unit tested (tests/unit/gitops.test.ts) and cheap to import anywhere.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import {
  DELIVERY_KINDS,
  TOOL_LABELS,
  deliveryKindOf,
  type DeliveryKind,
  type Tool,
} from "./kinds";

export * from "./kinds";

/* ---------------------------------------------------------- states -- */

/**
 * - failing: failed, stalled, degraded, can't compare
 * - attention: out of sync, waiting on a dependency, missing, no status
 * - progressing: reconciling / syncing / rolling out
 */
export type Category = "failing" | "attention" | "progressing" | "healthy" | "suspended";

export const CATEGORY_RANK: Record<Category, number> = {
  failing: 0,
  attention: 1,
  progressing: 2,
  healthy: 3,
  suspended: 4,
};

export interface DeliveryState {
  category: Category;
  /** In words: "Failed", "Out of sync", "Reconciling". */
  label: string;
  tone: StatusTone;
  /** The controller's reason / condition type. */
  reason?: string;
  /** What the last reconcile / sync said. */
  message?: string;
  /** When the state began (ISO). */
  since?: string;
}

export interface Condition {
  type: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export const conditionOf = (object: any, type: string): Condition | undefined =>
  (Array.isArray(object?.status?.conditions) ? object.status.conditions : []).find(
    (c: Condition) => c?.type === type
  );

const toMs = (value: unknown) => {
  const ms = value ? new Date(String(value)).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/** Revisions in messages get the short form (`main@sha1:7f3c…` → `main@7f3c2a1`). */
export function readableMessage(message: string | undefined): string | undefined {
  const text = message?.trim();
  if (!text) return undefined;
  const readable = text
    .replace(/(sha1|sha256|blake3):([0-9a-f]{7})[0-9a-f]{8,}/gi, "$2")
    .replace(/^Applied revision: /, "Applied ");
  // Controllers often start lower case ("successfully synced"); acronyms ("rpc error") stay.
  return /^[a-z]{4,}\b/.test(readable) ? readable.charAt(0).toUpperCase() + readable.slice(1) : readable;
}

const FLUX_FAILURES: Record<string, string> = {
  HealthCheckFailed: "Unhealthy",
  BuildFailed: "Build failed",
  ArtifactFailed: "Source not ready",
  InstallFailed: "Install failed",
  UpgradeFailed: "Upgrade failed",
  TestFailed: "Tests failed",
  RollbackFailed: "Rollback failed",
  UninstallFailed: "Uninstall failed",
  GitOperationFailed: "Fetch failed",
  AuthenticationFailed: "Can't sign in",
  OCIPullFailed: "Pull failed",
  OCIArtifactPullFailed: "Pull failed",
  ChartPullFailed: "Chart pull failed",
  IndexationFailed: "Can't read index",
  URLInvalid: "Invalid URL",
  VerificationError: "Not verified",
  InvalidSTSConfiguration: "Invalid settings",
};

const HEALTH_WORDS: Record<string, string> = { InProgress: "isn't ready", Failed: "failed", NotFound: "doesn't exist", Unknown: "has no status" };

/**
 * Flux health check failures in words: "Health check failed after 5m0s:
 * timeout waiting for: [Deployment/payments/worker status: 'InProgress']" →
 * "Deployment worker isn't ready (waited 5m)". Other messages unchanged.
 */
export function healthCheckMessage(message: string | undefined): string | undefined {
  const failed = message?.match(/^Health check failed after ([^:]+): timeout waiting for: \[(.*)\]$/s);
  if (!failed) return message;
  const objects = [...failed[2]!.matchAll(/([A-Za-z]+)\/(?:[a-z0-9.-]+\/)?([a-z0-9.-]+) status: '([A-Za-z]+)'/g)];
  if (!objects.length) return message;
  const waited = failed[1]!.replace(/(\d)m0s$/, "$1m").replace(/(\d)h0m0s$/, "$1h");
  const words = objects.slice(0, 3).map(([, kind, name, status]) => `${kind} ${name} ${HEALTH_WORDS[status!] ?? status}`);
  const more = objects.length > 3 ? `, and ${objects.length - 3} more` : "";
  return `${words.join(", ")}${more} (waited ${waited}).`;
}

/** Objects without any status this long after creation: the controller isn't looking. */
export const NO_STATUS_GRACE_MS = 5 * 60_000;

/** State of a Flux object (Kustomization, HelmRelease, or a source). */
export function fluxState(object: any, now = Date.now()): DeliveryState {
  const ready = conditionOf(object, "Ready");
  const stalled = conditionOf(object, "Stalled");
  const reconciling = conditionOf(object, "Reconciling");
  const message = readableMessage(healthCheckMessage(ready?.message));
  const since = ready?.lastTransitionTime;

  if (object?.spec?.suspend === true) {
    return { category: "suspended", label: "Suspended", tone: "muted", reason: ready?.reason, message, since };
  }
  if (stalled?.status === "True") {
    return {
      category: "failing",
      label: "Stalled",
      tone: "destructive",
      reason: stalled.reason,
      // Stalled says it gave up; Ready still says why.
      message:
        ready?.status === "False" && stalled.message && message
          ? `${readableMessage(stalled.message)}: ${message}`
          : readableMessage(stalled.message) ?? message,
      since: stalled.lastTransitionTime ?? since,
    };
  }
  if (ready?.status === "False") {
    if (ready.reason === "DependencyNotReady") {
      return { category: "attention", label: "Waiting on dependencies", tone: "warning", reason: ready.reason, message, since };
    }
    return {
      category: "failing",
      label: FLUX_FAILURES[ready.reason ?? ""] ?? "Failed",
      tone: "destructive",
      reason: ready.reason,
      message,
      since,
    };
  }
  const generation = object?.metadata?.generation;
  const observed = object?.status?.observedGeneration;
  const behind = typeof generation === "number" && typeof observed === "number" && observed < generation;
  if (ready?.status === "Unknown" || reconciling?.status === "True" || (ready && behind)) {
    return {
      category: "progressing",
      label: "Reconciling",
      tone: "info",
      reason: reconciling?.reason ?? ready?.reason,
      message: readableMessage(reconciling?.message) ?? message,
      since: reconciling?.lastTransitionTime ?? since,
    };
  }
  if (ready?.status === "True") {
    return { category: "healthy", label: "Ready", tone: "success", reason: ready.reason, message, since };
  }
  const created = toMs(object?.metadata?.creationTimestamp);
  if (created === null || now - created < NO_STATUS_GRACE_MS) {
    return { category: "progressing", label: "Pending", tone: "info", message: "Waiting for Flux to pick this up." };
  }
  return {
    category: "attention",
    label: "No status",
    tone: "warning",
    message: "Flux hasn't reported on this yet. Is its controller running?",
  };
}

const ARGO_CONDITIONS: Record<string, string> = {
  ComparisonError: "Can't compare",
  SyncError: "Sync failed",
  InvalidSpecError: "Invalid spec",
  UnknownError: "Error",
};

const rawArgoResources = (app: any): any[] =>
  Array.isArray(app?.status?.resources) ? app.status.resources : [];

/** The health message of an Argo CD app: its own, else that of its first unhealthy resource. */
function argoHealthMessage(app: any, status: string): string | undefined {
  if (app?.status?.health?.message) return readableMessage(app.status.health.message);
  const resource = rawArgoResources(app).find((r) => r?.health?.status === status && r.health.message);
  if (!resource) return undefined;
  const message = readableMessage(resource.health.message);
  // Most messages name their object already ('Deployment "web" exceeded…').
  return message?.includes(resource.name) ? message : `${resource.kind} ${resource.name}: ${message}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** State of an Argo CD Application (sync status, health, last operation, conditions). */
export function argoState(app: any, now = Date.now()): DeliveryState {
  const status = app?.status ?? {};
  const sync: string = status.sync?.status ?? "Unknown";
  const health: string = status.health?.status ?? "Unknown";
  const operation = status.operationState;
  const phase: string | undefined = operation?.phase;
  const errors: Condition[] = (Array.isArray(status.conditions) ? status.conditions : []).filter((c: Condition) =>
    /Error$/.test(c?.type ?? "")
  );

  if (phase === "Running" || phase === "Terminating" || app?.operation) {
    return {
      category: "progressing",
      label: phase === "Terminating" ? "Stopping sync" : "Syncing",
      tone: "info",
      reason: phase,
      message: readableMessage(operation?.message),
      since: operation?.startedAt,
    };
  }
  if (errors.length) {
    const first = errors[0]!;
    return {
      category: "failing",
      label: ARGO_CONDITIONS[first.type] ?? "Error",
      tone: "destructive",
      reason: first.type,
      message: readableMessage(first.message),
      since: first.lastTransitionTime,
    };
  }
  const failedSync = phase === "Failed" || phase === "Error";
  if (failedSync && sync !== "Synced") {
    return {
      category: "failing",
      label: "Sync failed",
      tone: "destructive",
      reason: phase,
      message: readableMessage(operation?.message),
      since: operation?.finishedAt,
    };
  }
  if (health === "Degraded") {
    return { category: "failing", label: "Degraded", tone: "destructive", reason: health, message: argoHealthMessage(app, health), since: status.health?.lastTransitionTime };
  }
  if (health === "Missing") {
    return { category: "attention", label: "Missing", tone: "warning", reason: health, message: "Some of its resources don't exist in the cluster yet." };
  }
  if (sync === "OutOfSync") {
    const differ = rawArgoResources(app).filter((r) => r?.status === "OutOfSync").length;
    return {
      category: "attention",
      label: "Out of sync",
      tone: "warning",
      reason: sync,
      message: differ ? `${plural(differ, "resource")} ${differ === 1 ? "differs" : "differ"} from Git.` : "The cluster differs from Git.",
    };
  }
  if (failedSync) {
    return { category: "attention", label: "Last sync failed", tone: "warning", reason: phase, message: readableMessage(operation?.message), since: operation?.finishedAt };
  }
  if (health === "Progressing") {
    return {
      category: "progressing",
      label: "Progressing",
      tone: "info",
      reason: health,
      message: argoHealthMessage(app, health) ?? "Waiting for its resources to become healthy.",
    };
  }
  if (health === "Suspended") {
    return { category: "suspended", label: "Suspended", tone: "muted", reason: health, message: argoHealthMessage(app, health) };
  }
  if (sync === "Unknown" || health === "Unknown") {
    const created = toMs(app?.metadata?.creationTimestamp);
    if (!status.reconciledAt && (created === null || now - created < NO_STATUS_GRACE_MS)) {
      return { category: "progressing", label: "Pending", tone: "info", message: "Waiting for Argo CD to compare it with Git." };
    }
    return { category: "attention", label: "Unknown", tone: "warning", message: "Argo CD couldn't tell its sync status or health." };
  }
  return {
    category: "healthy",
    label: "Synced",
    tone: "success",
    reason: sync,
    message: readableMessage(operation?.message),
    since: operation?.finishedAt,
  };
}

/* --------------------------------------------------------- sources -- */

/**
 * `https://github.com/acme/fleet.git` → `acme/fleet` (the last two path
 * segments), `https://kubernetes.github.io/ingress-nginx` → the host with
 * its one segment, a bare host stays a host.
 */
export function repoName(url: string | undefined): string {
  if (!url) return "";
  let rest = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  rest = rest.replace(/^[^@/]+@/, "");
  // scp-like `host:owner/repo` (not `host:22/...`)
  rest = rest.replace(/^([^/:]+):(?!\d)/, "$1/");
  rest = rest.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || url;
  return parts.slice(1).slice(-2).join("/");
}

/**
 * Revisions in short form: `main@sha1:7f3c2a1b…` → `main@7f3c2a1`, a bare
 * commit → 7 characters, chart versions and tags unchanged.
 */
export function shortRevision(revision: string | undefined): string {
  if (!revision) return "";
  const value = revision.trim().replace(/^refs\/(heads|tags)\//, "");
  const digest = value.match(/^(?:(.+?)[@/])?(?:sha1|sha256|blake3):([0-9a-f]+)$/i);
  if (digest) {
    const ref = digest[1]?.replace(/^refs\/(heads|tags)\//, "");
    return ref ? `${ref}@${digest[2]!.slice(0, 7)}` : digest[2]!.slice(0, 7);
  }
  const legacy = value.match(/^(.+)\/([0-9a-f]{40})$/i);
  if (legacy) return `${legacy[1]}@${legacy[2]!.slice(0, 7)}`;
  if (/^[0-9a-f]{40}$/i.test(value)) return value.slice(0, 7);
  return value;
}

/** What a Flux source ref follows: "Branch", "Tag", "Version" (semver range), "Commit". */
export function refKind(ref: any): string {
  if (!ref) return "Ref";
  if (ref.tag) return "Tag";
  if (ref.semver) return "Version";
  if (ref.branch) return "Branch";
  if (ref.commit && !ref.name) return "Commit";
  return "Ref";
}

/** A Flux source ref in words: `main`, `v1.2.0`, `>=6.0.0`. */
export function refLabel(ref: any): string {
  if (!ref) return "";
  if (ref.tag || ref.semver || ref.branch || ref.name) return ref.tag ?? ref.semver ?? ref.branch ?? ref.name;
  if (ref.commit) return String(ref.commit).slice(0, 7);
  return ref.digest ? shortRevision(ref.digest) : "";
}

const trimPath = (path: string | undefined) => (path ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");

export interface ObjectRef {
  kind: string;
  name: string;
  namespace: string;
}

export interface SourceSummary {
  /** The Flux source object(s), the repository first. */
  refs: ObjectRef[];
  url?: string;
  repo?: string;
  path?: string;
  /** Branch / tag / semver range. */
  ref?: string;
  /** What `ref` is: "Branch", "Tag", "Version", "Commit", "Ref". */
  refKind?: string;
  chart?: string;
  version?: string;
  /** The revision last applied / synced (short form). */
  revision?: string;
  /** For the row: `acme/fleet · clusters/prod · main@7f3c2a1`, `podinfo@6.5.4`. */
  short: string;
}

/** Finds a Flux source of the same context. */
export type SourceLookup = (ref: ObjectRef) => any | undefined;

const sourceUrl = (source: any): string | undefined => {
  if (!source) return undefined;
  if (source.kind === "Bucket") {
    const endpoint = source.spec?.endpoint;
    return endpoint ? `${endpoint.replace(/\/+$/, "")}/${source.spec?.bucketName ?? ""}` : source.spec?.bucketName;
  }
  return source.spec?.url;
};

export function fluxSource(object: any, lookup: SourceLookup = () => undefined): SourceSummary {
  const namespace = object?.metadata?.namespace ?? "";
  if (object?.kind === "HelmRelease") {
    const spec = object.spec?.chart?.spec;
    const chartRef = object.spec?.chartRef;
    const refs: ObjectRef[] = [];
    let chart: string | undefined = spec?.chart;
    let url: string | undefined;
    if (spec?.sourceRef?.name) {
      const repository = { kind: spec.sourceRef.kind, name: spec.sourceRef.name, namespace: spec.sourceRef.namespace ?? namespace };
      refs.push(repository);
      url = sourceUrl(lookup(repository));
      // helm-controller keeps the chart in a HelmChart next to the repository.
      const [chartNamespace, chartName] = String(object.status?.helmChart ?? "").split("/");
      refs.push(
        chartName
          ? { kind: "HelmChart", name: chartName, namespace: chartNamespace! }
          : { kind: "HelmChart", name: `${namespace}-${object.metadata?.name}`, namespace: repository.namespace }
      );
    } else if (chartRef?.name) {
      const ref = { kind: chartRef.kind, name: chartRef.name, namespace: chartRef.namespace ?? namespace };
      refs.push(ref);
      url = sourceUrl(lookup(ref));
      chart ??= url ? url.split("/").filter(Boolean).pop() : chartRef.name;
    }
    const history = Array.isArray(object.status?.history) ? object.status.history[0] : undefined;
    const version: string | undefined =
      history?.chartVersion ?? object.status?.lastAttemptedRevision ?? object.status?.lastAppliedRevision ?? spec?.version;
    const shortVersion = shortRevision(version);
    return {
      refs,
      url,
      repo: repoName(url),
      chart,
      version: shortVersion,
      revision: shortVersion,
      ref: spec?.version,
      short: chart ? (shortVersion ? `${chart}@${shortVersion}` : chart) : repoName(url),
    };
  }

  const sourceRef = object?.spec?.sourceRef;
  const refs: ObjectRef[] = sourceRef?.name
    ? [{ kind: sourceRef.kind, name: sourceRef.name, namespace: sourceRef.namespace ?? namespace }]
    : [];
  const source = refs[0] ? lookup(refs[0]) : undefined;
  const url = sourceUrl(source);
  const repo = repoName(url) || sourceRef?.name;
  const path = trimPath(object?.spec?.path);
  const revision = shortRevision(object?.status?.lastAppliedRevision ?? object?.status?.lastAttemptedRevision);
  return {
    refs,
    url,
    repo,
    path,
    ref: refLabel(source?.spec?.ref) || undefined,
    refKind: refKind(source?.spec?.ref),
    revision,
    short: [repo, path, revision].filter(Boolean).join(" · "),
  };
}

export function argoSource(app: any): SourceSummary {
  const source = app?.spec?.source ?? (Array.isArray(app?.spec?.sources) ? app.spec.sources[0] : undefined) ?? {};
  const synced = app?.status?.sync?.revision ?? (Array.isArray(app?.status?.sync?.revisions) ? app.status.sync.revisions[0] : undefined);
  const url: string | undefined = source.repoURL;
  const repo = repoName(url);
  if (source.chart) {
    const version = shortRevision(synced) || source.targetRevision;
    return {
      refs: [],
      url,
      repo,
      chart: source.chart,
      version,
      ref: source.targetRevision,
      revision: version,
      short: version ? `${source.chart}@${version}` : source.chart,
    };
  }
  const path = trimPath(source.path);
  const revision = shortRevision(synced);
  return {
    refs: [],
    url,
    repo,
    path,
    ref: source.targetRevision,
    revision,
    short: [repo, path, revision].filter(Boolean).join(" · "),
  };
}

/** A clickable https URL of a repository (ssh / scp-like / oci URLs mapped where possible). */
export function browsableUrl(url: string | undefined): string | null {
  if (!url) return null;
  const value = url.trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\.git$/, "");
  const ssh = value.match(/^(?:ssh:\/\/)?[^@/]+@([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return null;
}

/* ------------------------------------------------------- resources -- */

export interface InventoryEntry {
  namespace: string;
  name: string;
  group: string;
  kind: string;
  version?: string;
}

/** A Flux inventory id: `<namespace>_<name>_<group>_<kind>` (namespace / group may be empty). */
export function parseInventoryId(id: string, version?: string): InventoryEntry | null {
  const parts = String(id ?? "").split("_");
  if (parts.length < 4) return null;
  const kind = parts.pop()!;
  const group = parts.pop()!;
  const namespace = parts.shift()!;
  const name = parts.join("_");
  if (!name || !kind) return null;
  return { namespace, name, group, kind, ...(version ? { version } : {}) };
}

export interface DeliveredResource {
  key: string;
  kind: string;
  group: string;
  version?: string;
  namespace: string;
  name: string;
  /** Argo CD: Synced / OutOfSync. */
  sync?: string;
  /** Argo CD health, or "Unhealthy" from a failed Flux health check. */
  health?: string;
  tone: StatusTone;
  /** A word for the tooltip / the row: "Out of sync", "Degraded". */
  note?: string;
  message?: string;
}

/* Health check failures name the objects: `Deployment/payments/payments-worker status: 'InProgress'`. */
const HEALTH_FAILURE = /([A-Za-z]+)\/(?:([a-z0-9.-]+)\/)?([a-z0-9.-]+) status: '([A-Za-z]+)'/g;

export function fluxResources(object: any): DeliveredResource[] {
  const entries: any[] = Array.isArray(object?.status?.inventory?.entries) ? object.status.inventory.entries : [];
  const ready = conditionOf(object, "Ready");
  const failed = new Map<string, string>();
  for (const message of [ready?.message, conditionOf(object, "Healthy")?.message]) {
    if (!message) continue;
    for (const match of message.matchAll(HEALTH_FAILURE)) {
      failed.set(`${match[1]}/${match[2] ?? ""}/${match[3]}`, match[4]!);
    }
  }
  const applied = ready?.status === "True";
  const list: DeliveredResource[] = [];
  for (const entry of entries) {
    const parsed = parseInventoryId(entry?.id, entry?.v);
    if (!parsed) continue;
    const status = failed.get(`${parsed.kind}/${parsed.namespace}/${parsed.name}`);
    list.push({
      key: entry.id,
      ...parsed,
      ...(status ? { health: status, note: status === "InProgress" ? "Not ready" : status, message: `Health check: ${status}` } : {}),
      tone: status ? "destructive" : applied ? "success" : "muted",
    });
  }
  return list;
}

const ARGO_HEALTH_TONES: Record<string, StatusTone> = {
  Healthy: "success",
  Progressing: "info",
  Degraded: "destructive",
  Missing: "warning",
  Suspended: "muted",
  Unknown: "muted",
};

export function argoResources(app: any): DeliveredResource[] {
  return rawArgoResources(app).map((r: any) => {
    const health: string | undefined = r.health?.status;
    const outOfSync = r.status === "OutOfSync";
    const tone: StatusTone =
      health === "Degraded" || health === "Missing"
        ? ARGO_HEALTH_TONES[health]!
        : outOfSync
          ? "warning"
          : health
            ? ARGO_HEALTH_TONES[health] ?? "muted"
            : r.status === "Synced"
              ? "success"
              : "muted";
    const note = r.requiresPruning
      ? "Not in Git"
      : health === "Degraded" || health === "Missing"
        ? health
        : outOfSync
          ? "Out of sync"
          : health === "Progressing"
            ? "Progressing"
            : undefined;
    return {
      key: [r.group ?? "", r.kind, r.namespace ?? "", r.name].join("/"),
      kind: r.kind,
      group: r.group ?? "",
      version: r.version,
      namespace: r.namespace ?? "",
      name: r.name,
      sync: r.status,
      health,
      tone,
      ...(note ? { note } : {}),
      ...(r.health?.message ? { message: r.health.message } : {}),
    };
  });
}

const KIND_ORDER = [
  "Namespace", "CustomResourceDefinition", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob",
  "Service", "Ingress", "HTTPRoute", "ConfigMap", "Secret", "ServiceAccount", "Role", "RoleBinding",
  "ClusterRole", "ClusterRoleBinding", "HorizontalPodAutoscaler", "PodDisruptionBudget", "NetworkPolicy",
];
const kindRank = (kind: string) => {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
};
const toneRank = (tone: StatusTone) => (tone === "destructive" ? 0 : tone === "warning" ? 1 : tone === "info" ? 2 : 3);

export interface ResourceGroup {
  kind: string;
  items: DeliveredResource[];
  /** Items that need a look (out of sync, unhealthy). */
  problems: number;
}

/** Grouped by kind; groups and items with problems first, then the usual kind order. */
export function groupResources(list: DeliveredResource[]): ResourceGroup[] {
  const groups = new Map<string, DeliveredResource[]>();
  for (const item of list) {
    const items = groups.get(item.kind) ?? [];
    items.push(item);
    groups.set(item.kind, items);
  }
  return [...groups.entries()]
    .map(([kind, items]) => ({
      kind,
      items: [...items].sort((a, b) => toneRank(a.tone) - toneRank(b.tone) || a.name.localeCompare(b.name)),
      problems: items.filter((i) => i.tone === "destructive" || i.tone === "warning").length,
    }))
    .sort((a, b) => Number(b.problems > 0) - Number(a.problems > 0) || kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind));
}

/* ------------------------------------------------------- deliveries -- */

export interface Delivery {
  /** `<context>/<uid>` */
  key: string;
  uid: string;
  tool: Tool;
  kind: DeliveryKind;
  name: string;
  namespace: string;
  context: string;
  kubeConfig: string;
  object: any;
  state: DeliveryState;
  source: SourceSummary;
  /** Last applied (Flux) / synced (Argo CD), ISO. */
  lastApplied?: string;
  suspended: boolean;
  /**
   * While JET Pilot waits on an action, `state` says so ("Reconciling") and
   * this keeps the category it sorts and filters by, so the row stays put.
   */
  sortCategory?: Category;
}

const categoryOf = (delivery: Delivery) => delivery.sortCategory ?? delivery.state.category;

export function lastApplied(object: any): string | undefined {
  if (object?.kind === "Application") {
    const history = Array.isArray(object.status?.history) ? object.status.history : [];
    return object.status?.operationState?.finishedAt ?? history[history.length - 1]?.deployedAt;
  }
  if (object?.kind === "HelmRelease") {
    const history = Array.isArray(object.status?.history) ? object.status.history[0] : undefined;
    if (history?.lastDeployed) return history.lastDeployed;
  }
  return conditionOf(object, "Ready")?.lastTransitionTime;
}

export function toDelivery(object: any, lookup: SourceLookup = () => undefined, now = Date.now()): Delivery | null {
  const kind = deliveryKindOf(object);
  if (!kind) return null;
  const tool = DELIVERY_KINDS[kind].tool;
  const metadata = object.metadata ?? {};
  const uid = metadata.uid ?? `${metadata.namespace}/${metadata.name}`;
  return {
    key: `${metadata.context ?? ""}/${uid}`,
    uid,
    tool,
    kind,
    name: metadata.name ?? "",
    namespace: metadata.namespace ?? "",
    context: metadata.context ?? "",
    kubeConfig: metadata.kubeConfig ?? "",
    object,
    state: tool === "argo" ? argoState(object, now) : fluxState(object, now),
    source: tool === "argo" ? argoSource(object) : fluxSource(object, lookup),
    lastApplied: lastApplied(object),
    suspended: tool === "flux" && object.spec?.suspend === true,
  };
}

/** Problems first (failing, then attention), then in progress, healthy, suspended; by name within. */
export function compareDeliveries(a: Delivery, b: Delivery): number {
  return (
    CATEGORY_RANK[categoryOf(a)] - CATEGORY_RANK[categoryOf(b)] ||
    a.name.localeCompare(b.name) ||
    a.namespace.localeCompare(b.namespace) ||
    a.context.localeCompare(b.context)
  );
}

export type SectionId = "attention" | "progressing" | "healthy" | "suspended";

export const SECTION_TITLES: Record<SectionId, string> = {
  attention: "Needs attention",
  progressing: "In progress",
  healthy: "Healthy",
  suspended: "Suspended",
};

export const sectionOf = (category: Category): SectionId =>
  category === "failing" || category === "attention" ? "attention" : category;

export interface Section {
  id: SectionId;
  title: string;
  deliveries: Delivery[];
}

export function buildSections(deliveries: Delivery[]): Section[] {
  const sorted = [...deliveries].sort(compareDeliveries);
  const sections = new Map<SectionId, Delivery[]>();
  for (const delivery of sorted) {
    const id = sectionOf(categoryOf(delivery));
    sections.set(id, [...(sections.get(id) ?? []), delivery]);
  }
  return (Object.keys(SECTION_TITLES) as SectionId[])
    .filter((id) => sections.has(id))
    .map((id) => ({ id, title: SECTION_TITLES[id], deliveries: sections.get(id)! }));
}

export type DeliveryFilter = "all" | "attention" | "flux" | "argo";

export function matchesFilter(delivery: Delivery, filter: DeliveryFilter): boolean {
  if (filter === "attention") return sectionOf(categoryOf(delivery)) === "attention";
  if (filter === "flux" || filter === "argo") return delivery.tool === filter;
  return true;
}

/** Every word must match the name, namespace, context, kind, source or state. */
export function matchesQuery(delivery: Delivery, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    delivery.name,
    delivery.namespace,
    delivery.context,
    delivery.kind,
    TOOL_LABELS[delivery.tool],
    delivery.source.short,
    delivery.source.url,
    delivery.state.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** "24 deliveries · 1 failing · 2 out of sync", "6 deliveries · all healthy". */
export function summarize(deliveries: Delivery[]): string {
  const count = (test: (d: Delivery) => boolean) => deliveries.filter(test).length;
  const failing = count((d) => d.state.category === "failing");
  const outOfSync = count((d) => d.state.category === "attention" && d.state.label === "Out of sync");
  const attention = count((d) => d.state.category === "attention") - outOfSync;
  const progressing = count((d) => d.state.category === "progressing");
  const suspended = count((d) => d.state.category === "suspended");
  const parts = [plural(deliveries.length, "delivery").replace("deliverys", "deliveries")];
  if (failing) parts.push(`${failing} failing`);
  if (outOfSync) parts.push(`${outOfSync} out of sync`);
  if (attention) parts.push(`${attention} waiting`);
  if (!failing && !outOfSync && !attention && deliveries.length) {
    parts.push(progressing ? `${progressing} in progress` : "all healthy");
    if (suspended) parts.push(`${suspended} suspended`);
  }
  return parts.join(" · ");
}

/* ------------------------------------------------- pending actions -- */

export type PendingKind = "reconcile" | "sync" | "refresh";

/** An action JET Pilot sent, until the controller answered it. */
export interface PendingAction {
  action: PendingKind;
  startedAt: number;
  /** reconcile: the requestedAt value Flux echoes in status.lastHandledReconcileAt. */
  token?: string;
  /** sync: startedAt of the operation before ours. */
  previousOperation?: string;
  /** refresh: resourceVersion of the patched object. */
  patchedVersion?: string;
  /** The delivery's category when the action started: its row stays there meanwhile. */
  category?: Category;
}

export const REFRESH_ANNOTATION = "argocd.argoproj.io/refresh";
export const RECONCILE_ANNOTATION = "reconcile.fluxcd.io/requestedAt";

/* resourceVersions are opaque, but etcd's are integers: compare those numerically. */
const newerVersion = (current: string | undefined, patched: string | undefined) => {
  if (!current || !patched) return false;
  const a = Number(current);
  const b = Number(patched);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : current !== patched;
};

/** Whether the controller has answered `pending` (the object is the latest one seen). */
export function pendingSettled(object: any, pending: PendingAction): boolean {
  switch (pending.action) {
    case "reconcile":
      return !!pending.token && object?.status?.lastHandledReconcileAt === pending.token;
    case "sync": {
      const operation = object?.status?.operationState;
      return (
        !object?.operation &&
        !!operation?.startedAt &&
        operation.startedAt !== pending.previousOperation &&
        operation.phase !== "Running" &&
        operation.phase !== "Terminating"
      );
    }
    case "refresh":
      return (
        !object?.metadata?.annotations?.[REFRESH_ANNOTATION] &&
        newerVersion(object?.metadata?.resourceVersion, pending.patchedVersion)
      );
  }
}

const PENDING_LABELS: Record<PendingKind, string> = {
  reconcile: "Reconciling",
  sync: "Syncing",
  refresh: "Refreshing",
};

/** The delivery while JET Pilot waits on `pending` (it keeps its place in the list). */
export const withPending = (delivery: Delivery, pending: PendingAction | undefined): Delivery =>
  pending
    ? { ...delivery, state: pendingState(pending), sortCategory: pending.category ?? delivery.state.category }
    : delivery;

export const pendingState = (pending: PendingAction): DeliveryState => ({
  category: "progressing",
  label: PENDING_LABELS[pending.action],
  tone: "info",
  message:
    pending.action === "reconcile"
      ? "Asked Flux to reconcile now."
      : pending.action === "sync"
        ? "Asked Argo CD to sync."
        : "Asked Argo CD to compare with Git again.",
  since: new Date(pending.startedAt).toISOString(),
});
