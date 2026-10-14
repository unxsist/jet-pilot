/*
 * Pure helpers for Helm: releases, revisions, values, manifests, chart
 * search results and the helm command lines JET Pilot runs. Unit tested.
 */
import yaml from "js-yaml";
import { formatDistanceStrict } from "date-fns";
import type { StatusTone } from "@/components/ui/status/tones";

export interface ChartRef {
  name: string;
  version: string;
}

/**
 * Splits the `chart` column of `helm list` (`<name>-<version>`) into name
 * and version: `kube-prometheus-stack-61.3.2`, `cert-manager-v1.15.1`,
 * `app-1.0.0-rc.1`.
 */
export function parseChartField(chart: string): ChartRef {
  const match = /^(.+)-(v?\d+\.\d+[\w.+-]*)$/.exec(chart.trim());
  return match
    ? { name: match[1], version: match[2] }
    : { name: chart.trim(), version: "" };
}

export interface ChartSearchResult {
  name: string; // repo/chart
  version: string;
  app_version?: string;
  description?: string;
}

/**
 * `helm search repo --versions -o json` results for `chartName`: exact chart
 * name matches only, grouped per repository reference.
 */
export function chartVersionsByRepo(
  results: ChartSearchResult[],
  chartName: string
): Map<string, ChartSearchResult[]> {
  const byRepo = new Map<string, ChartSearchResult[]>();
  for (const result of results) {
    const [, chart] = result.name.split("/");
    if (chart !== chartName) continue;
    const list = byRepo.get(result.name) ?? [];
    list.push(result);
    byRepo.set(result.name, list);
  }
  return byRepo;
}

/** Whether `helm plugin list` output lists the helm-diff plugin. */
export const hasDiffPlugin = (pluginList: string) =>
  pluginList
    .split(/\r?\n/)
    .slice(1)
    .some((line) => /^diff\s/.test(line.trim()));

/** Strips ANSI colour codes (helm diff output). */
export const stripAnsi = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, "");

/* ----------------------------------------------------------- releases -- */

/** A release (its latest revision), as the backend's `helm_releases` lists it. */
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  /** Chart name. */
  chart: string;
  chartVersion: string;
  appVersion: string;
  /** ISO timestamp of the last deployment. */
  updated?: string | null;
  description: string;
  icon?: string | null;
  storage?: string;
}

/** A release row of the table: tagged with the cluster it lives in. */
export type HelmReleaseRow = HelmRelease & {
  metadata: { context: string; kubeConfig: string; name: string; namespace: string };
  __rowVersion: string;
};

export interface HelmRevision {
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion: string;
  updated?: string | null;
  description: string;
  /** User-supplied values of the revision. */
  values: Record<string, unknown>;
}

export interface ChartMetadata {
  name: string;
  version: string;
  appVersion?: string | null;
  description?: string | null;
  home?: string | null;
  sources?: string[];
  icon?: string | null;
  keywords?: string[];
  maintainers?: { name: string; email?: string; url?: string }[];
  kubeVersion?: string | null;
  deprecated?: boolean;
  type?: string | null;
}

export interface HelmHook {
  name: string;
  kind: string;
  path: string;
  events: string[];
  weight: number;
  manifest: string;
  phase: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface HelmReleaseDetail {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  updated?: string | null;
  firstDeployed?: string | null;
  description: string;
  notes: string;
  chart: ChartMetadata;
  values: Record<string, unknown>;
  computedValues: Record<string, unknown>;
  valuesSchema?: Record<string, unknown> | null;
  manifest: string;
  hooks: HelmHook[];
}

export const releaseRow = (
  release: HelmRelease,
  context: string,
  kubeConfig: string
): HelmReleaseRow => ({
  ...release,
  metadata: { context, kubeConfig, name: release.name, namespace: release.namespace },
  // Unchanged releases keep their row object across refreshes.
  __rowVersion: `${release.revision}|${release.status}|${release.updated ?? ""}`,
});

/**
 * `helm list -o json` rows (the CLI fallback) as releases. helm prints the
 * revision as a string and `updated` in Go's default time format.
 */
export function releasesFromCli(rows: any[]): HelmRelease[] {
  return rows.map((row) => {
    const chart = parseChartField(String(row.chart ?? ""));
    return {
      name: String(row.name ?? ""),
      namespace: String(row.namespace ?? ""),
      revision: Number(row.revision) || 0,
      status: String(row.status ?? "unknown"),
      chart: chart.name,
      chartVersion: chart.version,
      appVersion: String(row.app_version ?? ""),
      updated: goTimeToIso(String(row.updated ?? "")),
      description: "",
    };
  });
}

/** `2026-10-12 08:15:30.123456 +0000 UTC` → ISO; null when unreadable. */
export function goTimeToIso(value: string): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{2})(\d{2})/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").slice(0, 4);
  const date = new Date(`${match[1]}T${match[2]}${fraction}${match[4]}:${match[5]}`);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

/** By name, then namespace, then cluster. */
export const sortReleases = <T extends HelmRelease & { metadata?: { context?: string } }>(
  releases: T[]
): T[] =>
  [...releases].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.namespace.localeCompare(b.namespace) ||
      (a.metadata?.context ?? "").localeCompare(b.metadata?.context ?? "")
  );

export const sortRevisionsDesc = <T extends { revision: number }>(revisions: T[]) =>
  [...revisions].sort((a, b) => b.revision - a.revision);

export interface ReleaseStatus {
  /** Plain words: "Deployed", "Upgrading", "Failed". */
  label: string;
  tone: StatusTone;
  /** Helm is still working on it (pending-*, uninstalling). */
  busy: boolean;
  /** Needs attention: failed, or stuck pending. */
  problem: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  deployed: "Deployed",
  failed: "Failed",
  "pending-install": "Installing",
  "pending-upgrade": "Upgrading",
  "pending-rollback": "Rolling back",
  uninstalling: "Uninstalling",
  uninstalled: "Uninstalled",
  superseded: "Superseded",
  unknown: "Unknown",
};

/** How a Helm release status reads and looks. */
export function releaseStatus(status: string): ReleaseStatus {
  const key = (status || "unknown").toLowerCase();
  const label =
    STATUS_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
  if (key === "deployed") return { label, tone: "success", busy: false, problem: false };
  if (key === "failed") return { label, tone: "destructive", busy: false, problem: true };
  if (key.startsWith("pending") || key === "uninstalling") {
    return { label, tone: "warning", busy: true, problem: true };
  }
  return { label, tone: "muted", busy: false, problem: false };
}

/** Tone of a Helm release status for badges. */
export function helmStatusTone(
  status: string
): "success" | "warning" | "destructive" | "muted" {
  return releaseStatus(status).tone as "success" | "warning" | "destructive" | "muted";
}

/** "2 hours ago", "16 days ago"; "" without a (valid) time. */
export function timeAgo(value: string | number | null | undefined, now = new Date()): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (isNaN(date.getTime())) return "";
  if (Math.abs(now.getTime() - date.getTime()) < 45_000) return "just now";
  return formatDistanceStrict(date, now, { addSuffix: true });
}

/** `name 1.2.3` of a release or revision. */
export const chartLabel = (r: { chart: string; chartVersion: string }) =>
  [r.chart, r.chartVersion].filter(Boolean).join(" ");

/* ------------------------------------------------------------- values -- */

/** Values as YAML; empty values as an empty document. */
export function valuesYaml(values: unknown): string {
  if (
    values === null ||
    values === undefined ||
    (typeof values === "object" && Object.keys(values as object).length === 0)
  ) {
    return "";
  }
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Dotted paths of values that differ between two value trees (maps are
 * compared key by key, lists as a whole): `["image.tag", "replicaCount"]`.
 */
export function changedValuePaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) =>
      changedValuePaths(before[key], after[key], prefix ? `${prefix}.${key}` : key)
    );
  }
  if (sameValue(before, after)) return [];
  return [prefix || "(values)"];
}

/** "image.tag and replicaCount", "a, b and 3 more". */
export function describePaths(paths: string[], max = 2): string {
  if (paths.length === 0) return "";
  if (paths.length <= max) {
    return paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
  }
  return `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`;
}

/* ----------------------------------------------------------- manifests -- */

export interface ManifestObject {
  apiVersion: string;
  kind: string;
  name: string;
  /** Empty for cluster-scoped kinds. */
  namespace: string;
  /** Template the object came from (`# Source:` comment). */
  source?: string;
}

/* Kinds without a namespace (the common ones charts ship). */
const CLUSTER_SCOPED = new Set([
  "APIService",
  "CSIDriver",
  "ClusterIssuer",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "IngressClass",
  "MutatingWebhookConfiguration",
  "Namespace",
  "PersistentVolume",
  "PriorityClass",
  "RuntimeClass",
  "StorageClass",
  "ValidatingAdmissionPolicy",
  "ValidatingAdmissionPolicyBinding",
  "ValidatingWebhookConfiguration",
]);

export const isClusterScoped = (kind: string) => CLUSTER_SCOPED.has(kind);

/**
 * The objects of a rendered manifest (`---`-separated YAML documents,
 * `List`s expanded). Objects without a namespace get `namespace` unless
 * their kind is cluster-scoped. Unparseable documents are skipped.
 */
export function parseManifest(manifest: string, namespace = ""): ManifestObject[] {
  const objects: ManifestObject[] = [];
  for (const doc of manifest.split(/^---[^\S\r\n]*$/m)) {
    if (!doc.trim()) continue;
    const source = /^#\s*Source:\s*(.+)$/m.exec(doc)?.[1]?.trim();
    let parsed: any;
    try {
      parsed = yaml.load(doc);
    } catch {
      continue;
    }
    const items = parsed?.kind === "List" && Array.isArray(parsed.items) ? parsed.items : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object" || !item.kind || !item.metadata?.name) continue;
      const kind = String(item.kind);
      objects.push({
        apiVersion: String(item.apiVersion ?? ""),
        kind,
        name: String(item.metadata.name),
        namespace: isClusterScoped(kind) ? "" : String(item.metadata.namespace ?? namespace),
        ...(source ? { source } : {}),
      });
    }
  }
  return objects;
}

/* The order kinds are listed in: what runs first, then how it's reached, configured, allowed. */
const KIND_ORDER = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "Pod",
  "Service",
  "Ingress",
  "HTTPRoute",
  "ConfigMap",
  "Secret",
  "PersistentVolumeClaim",
  "HorizontalPodAutoscaler",
  "PodDisruptionBudget",
  "NetworkPolicy",
  "ServiceAccount",
  "Role",
  "RoleBinding",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
];

const kindRank = (kind: string) => {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
};

export interface KindGroup<T extends { kind: string; name: string } = ManifestObject> {
  kind: string;
  objects: T[];
}

/** Objects grouped by kind (well-known kinds first, then A–Z), names sorted. */
export function groupByKind<T extends { kind: string; name: string }>(objects: T[]): KindGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const object of objects) {
    const list = groups.get(object.kind) ?? [];
    list.push(object);
    groups.set(object.kind, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => kindRank(a) - kindRank(b) || a.localeCompare(b))
    .map(([kind, list]) => ({
      kind,
      objects: [...list].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** "Deployment" → "Deployments" for counts. */
export function pluralKindLabel(kind: string, count: number): string {
  if (count === 1) return kind;
  if (/(s|x|ch|sh)$/.test(kind)) return `${kind}es`;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

/* ----------------------------------------------------- chart search -- */

export interface HelmRepo {
  name: string;
  url: string;
}

export interface ArtifactHubChart {
  packageId: string;
  name: string;
  displayName?: string | null;
  description: string;
  version: string;
  appVersion: string;
  repoName: string;
  repoDisplayName?: string | null;
  repoUrl: string;
  logoImageId?: string | null;
  official: boolean;
  verifiedPublisher: boolean;
  cncf: boolean;
  deprecated: boolean;
  signed: boolean;
  stars: number;
  updated?: number | null;
}

export interface ArtifactHubVersion {
  version: string;
  appVersion: string;
  prerelease: boolean;
  updated?: number | null;
}

export interface ArtifactHubPackage extends ArtifactHubChart {
  homeUrl?: string | null;
  readme: string;
  keywords: string[];
  links: { name: string; url: string }[];
  license?: string | null;
  hasValuesSchema: boolean;
  versions: ArtifactHubVersion[];
}

/** A chart from either source, as the Charts page lists it. */
export interface ChartEntry {
  /** Unique per source + repo + chart. */
  key: string;
  source: "repo" | "artifacthub";
  name: string;
  description: string;
  version: string;
  appVersion: string;
  /** Repository name (yours, or Artifact Hub's). */
  repo: string;
  repoLabel: string;
  repoUrl?: string;
  /** Configured repository serving this chart, when there is one. */
  localRepo?: string;
  /** `repo/chart` for helm (once the repository is added). */
  reference: string;
  official: boolean;
  verified: boolean;
  deprecated: boolean;
  logoImageId?: string;
  packageId?: string;
}

export const normalizeRepoUrl = (url: string) =>
  url.trim().replace(/\/+$/, "").replace(/^http:\/\//, "https://").toLowerCase();

/** `helm search repo -o json` rows as chart entries. */
export function chartsFromRepoSearch(results: ChartSearchResult[], repos: HelmRepo[] = []): ChartEntry[] {
  const urls = new Map(repos.map((r) => [r.name, r.url]));
  return results.map((result) => {
    const [repo, ...rest] = result.name.split("/");
    const name = rest.join("/") || repo;
    return {
      key: `repo:${result.name}`,
      source: "repo",
      name,
      description: result.description ?? "",
      version: result.version,
      appVersion: result.app_version ?? "",
      repo,
      repoLabel: repo,
      repoUrl: urls.get(repo),
      localRepo: repo,
      reference: result.name,
      official: false,
      verified: false,
      deprecated: /^DEPRECATED/i.test(result.description ?? ""),
    };
  });
}

/**
 * Artifact Hub results as chart entries. A chart whose repository you
 * already added is installed through that repository's name.
 */
export function chartsFromArtifactHub(charts: ArtifactHubChart[], repos: HelmRepo[] = []): ChartEntry[] {
  const byUrl = new Map(repos.map((r) => [normalizeRepoUrl(r.url), r.name]));
  return charts.map((chart) => {
    const localRepo = byUrl.get(normalizeRepoUrl(chart.repoUrl));
    return {
      key: `artifacthub:${chart.repoName}/${chart.name}`,
      source: "artifacthub",
      name: chart.name,
      description: chart.description,
      version: chart.version,
      appVersion: chart.appVersion,
      repo: chart.repoName,
      repoLabel: chart.repoDisplayName || chart.repoName,
      repoUrl: chart.repoUrl,
      localRepo,
      reference: `${localRepo ?? chart.repoName}/${chart.name}`,
      official: chart.official,
      verified: chart.verifiedPublisher,
      deprecated: chart.deprecated,
      logoImageId: chart.logoImageId ?? undefined,
      packageId: chart.packageId,
    };
  });
}

/**
 * Merges Artifact Hub results into the repository results: a chart that
 * is in one of your repositories stays there, and gains Artifact Hub's
 * logo and official / verified mark; the rest is returned as `hub`.
 */
export function mergeChartResults(
  local: ChartEntry[],
  hub: ChartEntry[]
): { local: ChartEntry[]; hub: ChartEntry[] } {
  const fromHub = new Map(hub.filter((c) => c.localRepo).map((c) => [`${c.localRepo}/${c.name}`, c]));
  return {
    local: local.map((entry) => {
      const match = fromHub.get(`${entry.localRepo}/${entry.name}`);
      return match
        ? {
            ...entry,
            logoImageId: match.logoImageId,
            official: match.official,
            verified: match.verified,
            packageId: match.packageId,
          }
        : entry;
    }),
    hub: hub.filter((c) => !(c.localRepo && local.some((l) => l.localRepo === c.localRepo && l.name === c.name))),
  };
}

/* ------------------------------------------------------- repositories -- */

/** Why a repository name can't be used, or "". */
export function repoNameProblem(name: string, existing: HelmRepo[] = []): string {
  const value = name.trim();
  if (!value) return "Give the repository a name";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return "Letters, digits, dots, dashes and underscores only";
  }
  if (existing.some((r) => r.name === value)) return `You already have a repository named ${value}`;
  return "";
}

/** Why a repository URL can't be used, or "". */
export function repoUrlProblem(url: string, existing: HelmRepo[] = []): string {
  const value = url.trim();
  if (!value) return "Enter the repository's URL";
  if (value.startsWith("oci://")) {
    return "OCI registries don't need a repository: install with the oci:// reference";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That isn't a URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Use an https:// URL";
  const same = existing.find((r) => normalizeRepoUrl(r.url) === normalizeRepoUrl(value));
  if (same) return `This is ${same.name}`;
  return "";
}

/** A repository name for an Artifact Hub repository that doesn't clash. */
export function suggestRepoName(name: string, existing: HelmRepo[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "charts";
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/* ------------------------------------------------------------ install -- */

/** Why a release name can't be used, or "". */
export function releaseNameProblem(name: string): string {
  const value = name.trim();
  if (!value) return "Give the release a name";
  if (value.length > 53) return "At most 53 characters";
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(value)) {
    return "Lowercase letters, digits and dashes; start and end with a letter or digit";
  }
  return "";
}

/** Why a namespace name can't be used, or "". */
export function namespaceProblem(name: string): string {
  const value = name.trim();
  if (!value) return "Pick a namespace";
  if (value.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    return "Lowercase letters, digits and dashes, at most 63 characters";
  }
  return "";
}

export interface InstallOptions {
  release: string;
  /** `repo/chart` or `oci://…`. */
  chart: string;
  version?: string;
  namespace: string;
  createNamespace: boolean;
  context: string;
  kubeConfig?: string;
  dryRun?: boolean;
  /** Wait for the resources to be ready (and roll back when they aren't). */
  atomic?: boolean;
}

/** `helm install` arguments (values are passed separately, as a file). */
export function installArgs(o: InstallOptions): string[] {
  return [
    "install",
    o.release.trim(),
    o.chart.trim(),
    ...(o.version?.trim() ? [`--version=${o.version.trim()}`] : []),
    `--namespace=${o.namespace.trim()}`,
    ...(o.createNamespace ? ["--create-namespace"] : []),
    ...(o.dryRun ? ["--dry-run"] : []),
    ...(o.atomic && !o.dryRun ? ["--atomic", "--timeout=10m"] : []),
    "--output=json",
    `--kube-context=${o.context}`,
    ...(o.kubeConfig ? [`--kubeconfig=${o.kubeConfig}`] : []),
  ];
}

export interface InstallResult {
  status: string;
  revision: number;
  manifest: string;
  notes: string;
  hooks: { name: string; kind: string; events: string[] }[];
}

/** The release `helm install --output=json` prints. */
export function parseInstallOutput(stdout: string): InstallResult | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const release = JSON.parse(stdout.slice(start));
    return {
      status: String(release?.info?.status ?? ""),
      revision: Number(release?.version ?? 0),
      manifest: String(release?.manifest ?? ""),
      notes: String(release?.info?.notes ?? ""),
      hooks: Array.isArray(release?.hooks)
        ? release.hooks.map((h: any) => ({
            name: String(h?.name ?? ""),
            kind: String(h?.kind ?? ""),
            events: Array.isArray(h?.events) ? h.events.map(String) : [],
          }))
        : [],
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- notes -- */

export type NotesBlock =
  | { type: "text"; text: string }
  | { type: "command"; text: string };

const COMMAND_START =
  /^\s*(\$\s+)?((kubectl|helm|export|curl|echo|minikube|kind|aws|gcloud|az|watch|sleep)\s|(for|while|if)\s.*;|[A-Z_]+=\$\()/;

/**
 * Release notes split into prose and commands: runs of lines that look
 * like shell commands (and their continuation lines) become one copyable
 * block, everything else stays text. Indentation is kept relative.
 */
export function splitNotes(notes: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  const lines = notes.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  let type: NotesBlock["type"] = "text";
  let current: string[] = [];
  const push = () => {
    if (type === "command") {
      const indent = Math.min(...current.map((l) => /^\s*/.exec(l)![0].length));
      blocks.push({ type, text: current.map((l) => l.slice(indent).replace(/^\$\s+/, "")).join("\n") });
    } else {
      const text = current.join("\n").replace(/^\n+|\n+$/g, "");
      if (text) blocks.push({ type, text });
    }
    current = [];
  };
  for (const line of lines) {
    const continues: boolean = type === "command" && /\\\s*$/.test(current[current.length - 1] ?? "");
    const next: NotesBlock["type"] = continues || COMMAND_START.test(line) ? "command" : "text";
    if (next !== type && current.length) push();
    type = next;
    current.push(line);
  }
  if (current.length) push();
  return blocks;
}

/* ------------------------------------------------------ live objects -- */

/* Kinds whose health the release panel follows live (their list resource). */
export const WATCHED_KINDS: Record<string, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  PersistentVolumeClaim: "persistentvolumeclaims",
};

export interface ObjectHealth {
  label: string;
  tone: StatusTone;
}

const replicaHealth = (ready: number, desired: number): ObjectHealth => {
  if (desired === 0) return { label: "Scaled to 0", tone: "muted" };
  if (ready >= desired) return { label: "Ready", tone: "success" };
  return { label: `${ready}/${desired} ready`, tone: ready === 0 ? "destructive" : "warning" };
};

/**
 * How a live object of a release is doing, for the kinds in WATCHED_KINDS;
 * a `null` object isn't in the cluster (any more).
 */
export function objectHealth(kind: string, object: any | null): ObjectHealth {
  if (!object) return { label: "Missing", tone: "warning" };
  const status = object.status ?? {};
  switch (kind) {
    case "Deployment":
    case "StatefulSet":
      return replicaHealth(status.readyReplicas ?? 0, object.spec?.replicas ?? 1);
    case "DaemonSet":
      return replicaHealth(status.numberReady ?? 0, status.desiredNumberScheduled ?? 0);
    case "Job": {
      const failed = (status.conditions ?? []).some(
        (c: any) => c.type === "Failed" && c.status === "True"
      );
      if (failed) return { label: "Failed", tone: "destructive" };
      if (status.succeeded) return { label: "Complete", tone: "success" };
      return { label: "Running", tone: "warning" };
    }
    case "PersistentVolumeClaim":
      return status.phase === "Bound"
        ? { label: "Bound", tone: "success" }
        : { label: status.phase || "Pending", tone: "warning" };
    default:
      return { label: "", tone: "success" };
  }
}
