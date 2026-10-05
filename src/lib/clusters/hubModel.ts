/*
 * The Clusters hub list (pure): filter tokens, grouping, favourites first,
 * hidden clusters last.
 *
 * Filter syntax: free text matches name, alias, server, account, region,
 * folder and tags; tokens narrow further:
 *   env:prod  provider:aws  tag:payments  folder:team-a
 *   is:active is:favorite is:hidden is:protected is:readonly is:unreachable
 */
import type { InventoryEntry } from "./inventory";
import type { ResolvedCluster } from "./meta";
import { ENVIRONMENTS } from "./meta";
import { PROVIDER_LABELS } from "./provider";
import type { ClusterStatus } from "./status";

export type GroupBy = "folder" | "provider" | "environment" | "kubeconfig" | "none";

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "folder", label: "Folder" },
  { value: "provider", label: "Provider" },
  { value: "environment", label: "Environment" },
  { value: "kubeconfig", label: "Kubeconfig file" },
  { value: "none", label: "No grouping" },
];

export interface HubCluster {
  entry: InventoryEntry;
  meta: ResolvedCluster;
  status?: ClusterStatus;
  active: boolean;
}

export interface HubGroup {
  id: string;
  title: string;
  /** Muted part of the heading (e.g. the account). */
  detail?: string;
  clusters: HubCluster[];
}

export interface HubFilter {
  text: string;
  env?: string;
  provider?: string;
  tag?: string;
  folder?: string;
  is: Set<string>;
}

export function parseHubFilter(query: string): HubFilter {
  const filter: HubFilter = { text: "", is: new Set() };
  const words: string[] = [];
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(env|provider|tag|folder|is):(.+)$/i.exec(token);
    if (!match) {
      words.push(token);
      continue;
    }
    const [, key, value] = match;
    const lower = value!.toLowerCase();
    if (key!.toLowerCase() === "is") filter.is.add(lower.replace("-", ""));
    else (filter as unknown as Record<string, string>)[key!.toLowerCase()] = lower;
  }
  filter.text = words.join(" ").toLowerCase();
  return filter;
}

const haystack = (cluster: HubCluster) =>
  [
    cluster.entry.context,
    cluster.meta.displayName,
    cluster.entry.server ?? "",
    cluster.entry.provider.account ?? "",
    cluster.entry.provider.region ?? "",
    cluster.meta.folder ?? "",
    ...cluster.meta.tags,
  ]
    .join(" ")
    .toLowerCase();

const envMatches = (cluster: HubCluster, env: string) => {
  if (!cluster.meta.env) return false;
  const info = ENVIRONMENTS.find((e) => e.value === cluster.meta.env)!;
  return [info.value, info.short.toLowerCase(), info.label.toLowerCase()].includes(env);
};

export function matchesFilter(cluster: HubCluster, filter: HubFilter): boolean {
  if (filter.text && !filter.text.split(" ").every((word) => haystack(cluster).includes(word))) return false;
  if (filter.env && !envMatches(cluster, filter.env)) return false;
  if (filter.provider) {
    const provider = cluster.entry.provider;
    if (provider.id !== filter.provider && !provider.label.toLowerCase().includes(filter.provider)) return false;
  }
  if (filter.tag && !cluster.meta.tags.some((tag) => tag.toLowerCase() === filter.tag)) return false;
  if (filter.folder && (cluster.meta.folder ?? "").toLowerCase() !== filter.folder) return false;
  for (const flag of filter.is) {
    if (flag === "active" && !cluster.active) return false;
    if ((flag === "favorite" || flag === "fav") && !cluster.meta.favorite) return false;
    if (flag === "hidden" && !cluster.meta.hidden) return false;
    if (flag === "protected" && !cluster.meta.protected) return false;
    if (flag === "readonly" && !cluster.meta.readOnly) return false;
    if (flag === "unreachable" && cluster.status?.reachability !== "unreachable") return false;
  }
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const byName = (a: HubCluster, b: HubCluster) => collator.compare(a.meta.displayName, b.meta.displayName);

const fileLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

function groupOf(cluster: HubCluster, groupBy: GroupBy): { id: string; title: string; detail?: string; order: string } {
  switch (groupBy) {
    case "folder":
      return cluster.meta.folder
        ? { id: `folder:${cluster.meta.folder}`, title: cluster.meta.folder, order: `0${cluster.meta.folder}` }
        : { id: "folder:", title: "No folder", order: "1" };
    case "provider": {
      const { provider } = cluster.entry;
      const detail = provider.account;
      return {
        id: `provider:${provider.id}:${detail ?? ""}`,
        title: PROVIDER_LABELS[provider.id],
        detail,
        order: `${provider.id === "other" ? "2" : provider.id === "local" ? "1" : "0"}${provider.id}${detail ?? ""}`,
      };
    }
    case "environment": {
      const index = ENVIRONMENTS.findIndex((e) => e.value === cluster.meta.env && !cluster.meta.envInferred);
      return index >= 0
        ? { id: `env:${ENVIRONMENTS[index]!.value}`, title: ENVIRONMENTS[index]!.label, order: String(index) }
        : { id: "env:", title: "No environment", order: "9" };
    }
    case "kubeconfig":
      return {
        id: `file:${cluster.entry.kubeConfig}`,
        title: fileLabel(cluster.entry.kubeConfig),
        detail: cluster.entry.kubeConfig,
        order: cluster.entry.kubeConfig,
      };
    case "none":
      return { id: "all", title: "All clusters", order: "" };
  }
}

export interface HubSections {
  favorites: HubCluster[];
  groups: HubGroup[];
  hidden: HubCluster[];
  /** Clusters matching the filter (favourites, groups and hidden). */
  total: number;
}

/**
 * Favourites first (only there), then the groups, then hidden clusters
 * (listed only when `showHidden`, or when the filter asks for them).
 */
export function buildSections(
  clusters: HubCluster[],
  groupBy: GroupBy,
  filter: HubFilter,
  showHidden: boolean
): HubSections {
  const matching = clusters.filter((cluster) => matchesFilter(cluster, filter)).sort(byName);
  const wantsHidden = showHidden || filter.is.has("hidden");
  const visible = matching.filter((cluster) => !cluster.meta.hidden);
  const favorites = visible.filter((cluster) => cluster.meta.favorite);
  const groups = new Map<string, HubGroup & { order: string }>();
  for (const cluster of visible) {
    if (cluster.meta.favorite) continue;
    const group = groupOf(cluster, groupBy);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, clusters: [] });
    groups.get(group.id)!.clusters.push(cluster);
  }
  const hidden = wantsHidden ? matching.filter((cluster) => cluster.meta.hidden) : [];
  return {
    favorites,
    groups: [...groups.values()]
      .sort((a, b) => collator.compare(a.order, b.order))
      .map((group) => ({ id: group.id, title: group.title, detail: group.detail, clusters: group.clusters })),
    hidden,
    total: visible.length + hidden.length,
  };
}

/** Folder names in use (edit dialog suggestions). */
export function folderNames(clusters: { meta: ResolvedCluster }[]): string[] {
  return [...new Set(clusters.map((c) => c.meta.folder).filter((f): f is string => !!f))].sort(collator.compare);
}
