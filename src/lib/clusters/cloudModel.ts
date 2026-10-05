/*
 * Pure helpers for cloud accounts and the catalog: start URL parsing, role
 * defaults, summaries and catalog grouping (unit tested, no IPC).
 */
import type { AwsProfile, CatalogCluster, CatalogEvent, CloudConnection } from "./cloud";
import type { HubFilter } from "./hubModel";

/**
 * An AWS access portal URL from what people tend to paste: the full URL,
 * `acme.awsapps.com/start`, the subdomain (`acme`) or a directory id
 * (`d-1234567890`). Null when it can't be one.
 */
export function parseStartUrl(input: string): string | null {
  const text = input.trim().replace(/\/+$/, "");
  if (!text) return null;
  if (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(text)) return `https://${text.toLowerCase()}.awsapps.com/start`;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    // The portal lives at /start; console sign-in URLs ("/start/#/…") keep only that.
    const path = url.pathname === "/" || url.pathname === "" ? "/start" : url.pathname.replace(/\/+$/, "");
    return `https://${url.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** The portal's short name for labels: `https://acme.awsapps.com/start` → "acme". */
export function portalName(startUrl: string): string {
  try {
    const host = new URL(startUrl).hostname;
    return host.endsWith(".awsapps.com") ? host.slice(0, -".awsapps.com".length) : host;
  } catch {
    return startUrl;
  }
}

/** Access portals your ~/.aws/config already knows, most used first. */
export function knownPortals(profiles: AwsProfile[]): { startUrl: string; region: string | null; profiles: number }[] {
  const portals = new Map<string, { startUrl: string; region: string | null; profiles: number }>();
  for (const profile of profiles) {
    const startUrl = profile.ssoStartUrl ? parseStartUrl(profile.ssoStartUrl) : null;
    if (!startUrl) continue;
    const portal = portals.get(startUrl) ?? { startUrl, region: null, profiles: 0 };
    portal.profiles++;
    portal.region ??= profile.ssoRegion ?? null;
    portals.set(startUrl, portal);
  }
  return [...portals.values()].sort((a, b) => b.profiles - a.profiles || a.startUrl.localeCompare(b.startUrl));
}

const KUBERNETES_ROLE = /eks|kube|k8s|platform|devops/i;

/**
 * The role to preselect for an account: the one picked for other accounts,
 * else one that sounds like Kubernetes access, else the first.
 */
export function defaultRole(roles: string[], preferred: string[] = []): string | null {
  if (!roles.length) return null;
  for (const role of preferred) if (roles.includes(role)) return role;
  return [...roles].sort().find((role) => KUBERNETES_ROLE.test(role)) ?? [...roles].sort()[0]!;
}

/** "All enabled regions", "eu-west-1", "eu-west-1, us-east-1 and 3 more". */
export function regionsSummary(regions: string[]): string {
  if (!regions.length) return "All enabled regions";
  if (regions.length <= 2) return regions.join(", ");
  return `${regions.slice(0, 2).join(", ")} and ${regions.length - 2} more`;
}

/** What a connection reaches: "4 accounts", "profile prod-admin", the caller. */
export function connectionScope(connection: CloudConnection): string {
  if (connection.kind === "sso") {
    const count = connection.targets.length;
    return count === 1
      ? (connection.targets[0]!.accountName ?? connection.targets[0]!.accountId)
      : `${count} accounts`;
  }
  if (connection.kind === "profile") return `Profile ${connection.profile ?? ""}`.trim();
  const account = /^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):/.exec(connection.identity ?? "")?.[1];
  return account ? `Account ${account}` : "Access keys";
}

/** "7 h left", "12 min left", "expired 3 h ago". */
export function expiryText(expiresAt: number | null | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const minutes = Math.round((expiresAt - now) / 60_000);
  const span = (m: number) => (m >= 90 ? `${Math.round(m / 60)} h` : `${Math.max(1, m)} min`);
  return minutes >= 0 ? `${span(minutes)} left` : `expired ${span(-minutes)} ago`;
}

/** Catalog clusters by what to do with them, each sorted for display. */
export function groupCatalog(clusters: CatalogCluster[]) {
  const order = (a: CatalogCluster, b: CatalogCluster) =>
    (a.accountName ?? a.accountId).localeCompare(b.accountName ?? b.accountId) ||
    a.region.localeCompare(b.region) ||
    a.name.localeCompare(b.name);
  const of = (state: CatalogCluster["state"]) => clusters.filter((c) => c.state === state).sort(order);
  return { available: of("available"), added: of("added"), ignored: of("ignored"), removed: of("removed") };
}

/** Where a catalog cluster lives: "acme-production · eu-west-1". */
export const catalogWhere = (cluster: CatalogCluster) => `${cluster.accountName ?? cluster.accountId} · ${cluster.region}`;

/*
 * A catalog refresh as the UI shows it: one line per scope (account ·
 * region), the clusters found so far, and whether it finished.
 */
export interface DiscoveryScope {
  scope: string;
  accountId: string | null;
  accountName: string | null;
  region: string | null;
  state: "running" | "done" | "error";
  message: string | null;
}

export interface DiscoveryState {
  scopes: DiscoveryScope[];
  clusters: CatalogCluster[];
  done: boolean;
  refreshedAt: number | null;
}

export const initialDiscovery = (): DiscoveryState => ({ scopes: [], clusters: [], done: false, refreshedAt: null });

export function reduceDiscovery(state: DiscoveryState, event: CatalogEvent): DiscoveryState {
  switch (event.type) {
    case "progress": {
      const next: DiscoveryScope = {
        scope: event.scope,
        accountId: event.accountId ?? null,
        accountName: event.accountName ?? null,
        region: event.region ?? null,
        state: event.state,
        message: event.message ?? null,
      };
      const index = state.scopes.findIndex((s) => s.scope === event.scope);
      const scopes = index < 0 ? [...state.scopes, next] : state.scopes.map((s, i) => (i === index ? next : s));
      return { ...state, scopes };
    }
    case "clusters": {
      const incoming = new Map(event.clusters.map((c) => [c.key, c]));
      const kept = state.clusters.filter((c) => !incoming.has(c.key));
      return { ...state, clusters: [...kept, ...incoming.values()] };
    }
    case "done":
      return { ...state, done: true, refreshedAt: event.refreshedAt };
  }
}

/** Counts for a progress line: scopes checked, with problems, clusters found. */
export function discoverySummary(state: DiscoveryState) {
  const finished = state.scopes.filter((s) => s.state !== "running").length;
  const failed = state.scopes.filter((s) => s.state === "error");
  return { total: state.scopes.length, finished, failed, found: state.clusters.length };
}

/*
 * The hub's "Available" section: catalog clusters not added yet that match
 * the hub filter. Metadata tokens (env, tag, folder) only match added
 * clusters; `is:available` shows only these; ignored ones come along with
 * hidden clusters.
 */
export function availableInHub(clusters: CatalogCluster[], filter: HubFilter, showHidden: boolean) {
  const sorted = groupCatalog(clusters);
  if (filter.env || filter.tag || filter.folder) return { available: [], ignored: [] };
  const flags = [...filter.is].filter((flag) => flag !== "available" && flag !== "hidden");
  if (flags.length) return { available: [], ignored: [] };
  const matches = (cluster: CatalogCluster) => {
    if (filter.provider && !["aws", "eks", "amazon"].some((word) => word.includes(filter.provider!))) return false;
    const haystack = [cluster.name, cluster.accountName ?? "", cluster.accountId, cluster.region, cluster.roleName ?? ""]
      .join(" ")
      .toLowerCase();
    return !filter.text || filter.text.split(" ").every((word) => haystack.includes(word));
  };
  const hiddenOnly = filter.is.has("hidden");
  return {
    available: hiddenOnly ? [] : sorted.available.filter(matches),
    ignored: showHidden || hiddenOnly ? sorted.ignored.filter(matches) : [],
  };
}

/** Scopes that failed, per account: "acme-audit · 6 regions: AccessDenied…". */
export function failureGroups(scopes: { scope: string; accountId?: string | null; accountName?: string | null; region?: string | null; message: string | null }[]) {
  const groups = new Map<string, { account: string; regions: string[]; message: string | null }>();
  for (const scope of scopes) {
    const account = scope.accountName ?? scope.accountId ?? scope.scope;
    const group = groups.get(account) ?? { account, regions: [], message: scope.message };
    if (scope.region) group.regions.push(scope.region);
    groups.set(account, group);
  }
  return [...groups.values()];
}

/** "acme-audit couldn't be checked in 6 regions", "3 accounts couldn't be fully checked". */
export function failureSummary(groups: ReturnType<typeof failureGroups>): string | null {
  if (!groups.length) return null;
  if (groups.length > 1) return `${groups.length} accounts couldn't be fully checked`;
  const [group] = groups;
  const count = group!.regions.length;
  return count > 1 ? `${group!.account} couldn't be checked in ${count} regions` : `${group!.account} couldn't be checked`;
}
