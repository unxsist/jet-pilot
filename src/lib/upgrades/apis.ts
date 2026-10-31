/*
 * Deprecated and removed APIs a cluster still uses, against the table
 * generated from Pluto's versions.yaml (data/apis.json, Apache-2.0, see
 * data/LICENSE-pluto.txt). Pure.
 *
 * Where uses come from:
 * - Helm releases: the stored manifest of the latest revision. A removed
 *   API there makes `helm upgrade` fail until the stored manifest is fixed.
 * - `kubectl.kubernetes.io/last-applied-configuration`: the manifest
 *   someone last applied. Applying it again fails once its API is gone.
 * - `managedFields`: the API version each client wrote the object with. A
 *   client still writing a deprecated version breaks when it's removed.
 */
import data from "./data/apis.json";
import { compareMinor, minorsBetween } from "./versions";

export interface ApiRule {
  apiVersion: string;
  kind: string;
  deprecated: string | null;
  removed: string | null;
  replacement: string | null;
  /** "k8s", or the add-on whose versions `deprecated` / `removed` refer to. */
  component: string;
}

export const API_RULES = data.apis as ApiRule[];
export const API_NOTICE = data.notice;

const RULES = new Map(API_RULES.map((rule) => [`${rule.apiVersion}/${rule.kind}`, rule]));

export const apiRule = (apiVersion: string, kind: string) => RULES.get(`${apiVersion}/${kind}`);

/** Minors ahead of the cluster's version that count as "about to be removed". */
export const UPCOMING_MINORS = 2;

/**
 * - removed: the cluster's (or add-on's) version no longer serves it;
 * - removing: removed within the next two minors;
 * - deprecated: deprecated already, removed later (or not yet scheduled).
 */
export type ApiState = "removed" | "removing" | "deprecated";

export function apiState(rule: ApiRule, version: string | null | undefined): ApiState | null {
  if (!version) return null;
  if (rule.removed && compareMinor(rule.removed, version) <= 0) return "removed";
  if (rule.removed && minorsBetween(version, rule.removed) <= UPCOMING_MINORS) return "removing";
  if (rule.deprecated && compareMinor(rule.deprecated, version) <= 0) return "deprecated";
  return null;
}

export type ApiSource =
  | { type: "helm"; release: string; namespace: string }
  | { type: "applied" }
  | { type: "manager"; manager: string; at: string | null };

export interface ApiUse {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  source: ApiSource;
}

export interface ApiFinding extends ApiUse {
  rule: ApiRule;
  state: ApiState;
}

/** The uses an object records: its last applied manifest and its writers. */
export function usesOfObject(kind: string, object: any): ApiUse[] {
  const metadata = object?.metadata ?? {};
  const base = { kind, name: String(metadata.name ?? ""), namespace: metadata.namespace || undefined };
  const uses: ApiUse[] = [];
  const applied = metadata.annotations?.["kubectl.kubernetes.io/last-applied-configuration"];
  if (typeof applied === "string") {
    // Only the apiVersion is needed: no full parse of large manifests.
    const apiVersion = /"apiVersion"\s*:\s*"([^"]+)"/.exec(applied)?.[1];
    if (apiVersion) uses.push({ ...base, apiVersion, source: { type: "applied" } });
  }
  const seen = new Set<string>();
  for (const entry of metadata.managedFields ?? []) {
    const apiVersion = entry?.apiVersion;
    const manager = entry?.manager;
    if (typeof apiVersion !== "string" || typeof manager !== "string") continue;
    const key = `${manager}/${apiVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uses.push({ ...base, apiVersion, source: { type: "manager", manager, at: entry.time ?? null } });
  }
  return uses;
}

const STATE_ORDER: Record<ApiState, number> = { removed: 0, removing: 1, deprecated: 2 };

/**
 * The uses that matter for a cluster on `version`, most urgent first. A
 * client recorded with an API that's already gone hasn't written since (it
 * couldn't have), so those stale managedFields entries are left out.
 * Add-on APIs (cert-manager, Istio) compare against the add-on's version.
 */
export function apiFindings(
  uses: ApiUse[],
  version: string | null,
  componentVersions: Record<string, string> = {}
): ApiFinding[] {
  const findings: ApiFinding[] = [];
  const seen = new Set<string>();
  for (const use of uses) {
    const rule = apiRule(use.apiVersion, use.kind);
    if (!rule) continue;
    const state = apiState(rule, rule.component === "k8s" ? version : componentVersions[rule.component]);
    if (!state) continue;
    if (state === "removed" && use.source.type === "manager") continue;
    const source =
      use.source.type === "helm"
        ? `helm/${use.source.namespace}/${use.source.release}`
        : use.source.type === "manager"
          ? `manager/${use.source.manager}`
          : "applied";
    const key = `${use.apiVersion}/${use.kind}/${use.namespace ?? ""}/${use.name}/${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...use, rule, state });
  }
  // An API that's gone only matters right away where Helm keeps it; an old applied manifest can wait.
  const rank = (f: ApiFinding) => (f.state === "removed" && f.source.type === "applied" ? 3 : STATE_ORDER[f.state]);
  const sourceOrder = (f: ApiFinding) => (f.source.type === "helm" ? 0 : f.source.type === "manager" ? 1 : 2);
  return findings.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      compareMinor(a.rule.removed ?? "99.0", b.rule.removed ?? "99.0") ||
      sourceOrder(a) - sourceOrder(b) ||
      a.name.localeCompare(b.name)
  );
}

/* Objects controllers create or that don't persist: their API versions say nothing about the user's manifests. */
const NOT_SCANNED = new Set([
  "Event",
  "ReplicaSet",
  "Lease",
  "EndpointSlice",
  "CSINode",
  "CSIStorageCapacity",
  "VolumeAttachment",
  "CertificateSigningRequest",
  "TokenReview",
  "FlowControl",
  "Policy",
]);

export interface KindToScan {
  kind: string;
  /** API groups that may serve it ("" is the core group). */
  groups: string[];
}

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");

/**
 * The Kubernetes kinds worth listing for a cluster on `version`: those with
 * an API version that's removed, about to be, or deprecated.
 */
export function kindsToScan(version: string): KindToScan[] {
  const kinds = new Map<string, Set<string>>();
  for (const rule of API_RULES) {
    if (rule.component !== "k8s" || NOT_SCANNED.has(rule.kind) || !apiState(rule, version)) continue;
    const groups = kinds.get(rule.kind) ?? new Set<string>();
    groups.add(groupOf(rule.apiVersion));
    if (rule.replacement) groups.add(groupOf(rule.replacement));
    kinds.set(rule.kind, groups);
  }
  return [...kinds.entries()]
    .map(([kind, groups]) => ({ kind, groups: [...groups] }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
