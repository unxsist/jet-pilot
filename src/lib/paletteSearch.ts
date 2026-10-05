/**
 * Command palette helpers: k9s-style resource jumps (`:po`, `:deploy`,
 * `:certificates`) and the recent-items list.
 */
import type { DiscoveredResource } from "@/lib/discovery";

export const JUMP_PREFIX = ":";

export function isJumpQuery(query: string): boolean {
  return query.trimStart().startsWith(JUMP_PREFIX);
}

/** The resource part of a jump query (":deploy" -> "deploy"). */
export function jumpTerm(query: string): string {
  return query.trimStart().slice(JUMP_PREFIX.length).trim().toLowerCase();
}

/**
 * Rank of `resource` for `term` (lower is better), or null when it does not
 * match: exact short name / name / kind, then prefixes, then substrings,
 * then in-order characters ("dpl" -> deployments).
 */
export function jumpRank(resource: DiscoveredResource, term: string): number | null {
  if (!term) return 50;
  const names = [
    resource.name,
    resource.kind.toLowerCase(),
    resource.singularName?.toLowerCase() ?? "",
    ...(resource.shortNames ?? []).map((s) => s.toLowerCase()),
  ].filter(Boolean);
  const full = resource.group ? `${resource.name}.${resource.group}` : resource.name;

  if (names.includes(term) || full === term) return 0;
  if (names.some((n) => n.startsWith(term))) return 10;
  if (full.includes(term)) return 20;
  if (isSubsequence(term, resource.name) || isSubsequence(term, resource.kind.toLowerCase())) {
    return 30;
  }
  return null;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

const groupRank = (group: string) =>
  group === "" ? 0 : !group.includes(".") || group.endsWith(".k8s.io") ? 1 : 2;

/** Matching resources, best first (built-in groups before CRDs). */
export function matchResources<T extends DiscoveredResource>(
  resources: T[],
  term: string
): T[] {
  return resources
    .map((resource) => ({ resource, rank: jumpRank(resource, term) }))
    .filter((m): m is { resource: T; rank: number } => m.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        groupRank(a.resource.group) - groupRank(b.resource.group) ||
        a.resource.kind.localeCompare(b.resource.kind)
    )
    .map((m) => m.resource);
}

export const MAX_RECENT = 6;

/** Adds `key` to the front of the recent list (deduplicated, bounded). */
export function pushRecent(recent: string[], key: string, max = MAX_RECENT): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}
