/*
 * Cluster metadata: what the user tells JET Pilot about a context (an alias,
 * a colour, a folder, tags, favourite / hidden, its environment and the
 * production guardrails). Stored as `clusters` in state.json, one record per
 * context. A record is keyed by kubeconfig + context name; records with an
 * empty kubeconfig (migrated from the old name-keyed cluster settings) apply
 * to that context name in every kubeconfig.
 */
import { contextKey } from "@/lib/contextKey";

export type Environment = "prod" | "staging" | "dev" | "test";

export const ENVIRONMENTS: { value: Environment; label: string; short: string }[] = [
  { value: "prod", label: "Production", short: "PROD" },
  { value: "staging", label: "Staging", short: "STG" },
  { value: "dev", label: "Development", short: "DEV" },
  { value: "test", label: "Test", short: "TEST" },
];

export type ClusterColor =
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal"
  | "blue"
  | "indigo"
  | "violet"
  | "pink"
  | "gray";

/** Hue per named colour (avatars, the window tint); gray has no saturation. */
export const CLUSTER_COLORS: Record<ClusterColor, number> = {
  red: 0,
  orange: 24,
  amber: 40,
  green: 145,
  teal: 175,
  blue: 212,
  indigo: 243,
  violet: 270,
  pink: 330,
  gray: 220,
};

export interface ClusterMeta {
  alias?: string;
  color?: ClusterColor;
  folder?: string;
  tags?: string[];
  favorite?: boolean;
  hidden?: boolean;
  env?: Environment;
  /** Guardrails (typed confirms, forced dry runs). Unset: on for production. */
  protected?: boolean;
  /** No changes from JET Pilot at all. */
  readOnly?: boolean;
  /** Namespaces to offer when listing them isn't allowed. */
  namespaces?: string[];
}

export interface ClusterRecord extends ClusterMeta {
  /** "" = this context name in any kubeconfig. */
  kubeConfig: string;
  context: string;
}

export interface ResolvedCluster {
  key: string;
  context: string;
  kubeConfig: string;
  /** The alias, else the cluster part of the context name. */
  displayName: string;
  initials: string;
  /** Avatar hue: the chosen colour, else derived from the name. */
  hue: number;
  color?: ClusterColor;
  env?: Environment;
  /** `env` was guessed from the name (shown as a hint, never protects). */
  envInferred: boolean;
  protected: boolean;
  readOnly: boolean;
  favorite: boolean;
  hidden: boolean;
  folder?: string;
  tags: string[];
  namespaces: string[];
}

/**
 * The record for a context: an exact (kubeconfig) match, else a wildcard.
 * Without a kubeconfig (callers that only know the name), any record of
 * that context name.
 */
export function findRecord(
  records: readonly ClusterRecord[],
  context: string,
  kubeConfig?: string
): ClusterRecord | undefined {
  let fallback: ClusterRecord | undefined;
  for (const record of records) {
    if (record.context !== context) continue;
    if (kubeConfig === undefined || record.kubeConfig === kubeConfig) return record;
    if (record.kubeConfig === "" && !fallback) fallback = record;
  }
  return fallback;
}

/** EKS / GKE context names are ARNs or paths: the cluster name is the last part. */
export function shortName(context: string): string {
  if (context.startsWith("gke_")) {
    const parts = context.split("_");
    return parts[parts.length - 1] || context;
  }
  return context.split(/[/:]/).filter(Boolean).pop() || context;
}

export function initialsOf(name: string): string {
  const base = shortName(name || "?");
  const parts = base.split(/[-_.@\s]+/).filter(Boolean);
  const first = parts[0] || base;
  const second = parts[1]?.[0] ?? first[1] ?? "";
  return (first[0] + second).toUpperCase();
}

export function nameHue(name: string): number {
  let hash = 0;
  for (const char of name || "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

const ENV_TOKENS: [RegExp, Environment][] = [
  [/^(prod|prd|production|live)$/, "prod"],
  [/^(stg|stage|staging|preprod|uat|acc|acceptance)$/, "staging"],
  [/^(dev|develop|development|sandbox)$/, "dev"],
  [/^(test|tst|qa)$/, "test"],
];

/** A guess from the name ("prod-eu-west-1" → prod); only ever a hint. */
export function inferEnvironment(name: string): Environment | undefined {
  const tokens = shortName(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    for (const [pattern, env] of ENV_TOKENS) if (pattern.test(token)) return env;
  }
  return undefined;
}

export function resolveCluster(
  records: readonly ClusterRecord[] | undefined,
  context: string,
  kubeConfig?: string
): ResolvedCluster {
  const record = records ? findRecord(records, context, kubeConfig) : undefined;
  const alias = record?.alias?.trim();
  const inferred = record?.env ? undefined : inferEnvironment(context);
  const env = record?.env ?? inferred;
  return {
    key: contextKey(context, kubeConfig ?? record?.kubeConfig ?? ""),
    context,
    kubeConfig: kubeConfig ?? record?.kubeConfig ?? "",
    displayName: alias || shortName(context),
    initials: alias ? initialsOf(alias) : initialsOf(context),
    hue: record?.color ? CLUSTER_COLORS[record.color] : nameHue(context),
    color: record?.color,
    env,
    envInferred: !!inferred,
    protected: record?.protected ?? record?.env === "prod",
    readOnly: !!record?.readOnly,
    favorite: !!record?.favorite,
    hidden: !!record?.hidden,
    folder: record?.folder?.trim() || undefined,
    tags: record?.tags ?? [],
    namespaces: record?.namespaces ?? [],
  };
}

const isEmpty = (meta: ClusterMeta) =>
  Object.values(meta).every(
    (value) => value === undefined || value === false || value === "" || (Array.isArray(value) && value.length === 0)
  );

/**
 * Applies `patch` to the record of a context (creating an exact record, or
 * turning a wildcard into one); records without any metadata are dropped.
 * Returns the new list.
 */
export function updateRecords(
  records: readonly ClusterRecord[],
  context: string,
  kubeConfig: string,
  patch: Partial<ClusterMeta>
): ClusterRecord[] {
  const existing = findRecord(records, context, kubeConfig);
  const base: ClusterRecord = existing && existing.kubeConfig === kubeConfig
    ? { ...existing }
    : { ...(existing ?? {}), kubeConfig, context };
  const next: ClusterRecord = { ...base, ...patch, kubeConfig, context };
  for (const key of Object.keys(next) as (keyof ClusterRecord)[]) {
    if (next[key] === undefined) delete next[key];
  }
  const others = records.filter((r) => !(r.context === context && r.kubeConfig === kubeConfig));
  const meta: ClusterMeta = { ...next };
  delete (meta as Partial<ClusterRecord>).kubeConfig;
  delete (meta as Partial<ClusterRecord>).context;
  return isEmpty(meta) ? others : [...others, next];
}

export const envInfo = (env: Environment | undefined) =>
  env ? ENVIRONMENTS.find((e) => e.value === env) : undefined;
