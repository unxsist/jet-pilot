/**
 * Matches a Kubernetes metadata map (labels or annotations) against a filter
 * query: comma-separated terms that must all match, case-insensitive.
 *
 * - `key=value` or `key==value`: the key has exactly that value (`key=`:
 *   an empty value)
 * - `key!=value`: the key is absent or has another value
 * - `!key`: the key is absent
 * - anything else: a substring of a key or a value
 *
 * A key matches by its full name or by its last segment, so `arch` finds
 * `kubernetes.io/arch`.
 */
export function matchesMetadataQuery(
  entries: Record<string, string> | undefined | null,
  query: string
): boolean {
  const terms = query
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;

  const pairs = Object.entries(entries ?? {}).map(
    ([key, value]) => [key.toLowerCase(), String(value ?? "").toLowerCase()] as const
  );
  const keyMatches = (key: string, wanted: string) =>
    key === wanted || key.slice(key.lastIndexOf("/") + 1) === wanted;

  return terms.every((raw) => {
    const term = raw.toLowerCase();

    const notEqual = term.indexOf("!=");
    if (notEqual > 0) {
      const key = term.slice(0, notEqual).trim();
      const value = term.slice(notEqual + 2).trim();
      return !pairs.some(([k, v]) => keyMatches(k, key) && v === value);
    }

    if (term.startsWith("!") && !term.includes("=")) {
      const key = term.slice(1).trim();
      return !key || !pairs.some(([k]) => keyMatches(k, key));
    }

    const equal = term.indexOf("=");
    if (equal > 0) {
      const key = term.slice(0, equal).trim();
      const value = term.slice(term[equal + 1] === "=" ? equal + 2 : equal + 1).trim();
      return pairs.some(([k, v]) => keyMatches(k, key) && v === value);
    }

    return pairs.some(([k, v]) => k.includes(term) || v.includes(term));
  });
}

export interface MetadataFacetOption {
  /** Formatted `key=value` or `key` */
  item: string;
  key: string;
  value: string;
  count: number;
}

/**
 * Collects distinct `key=value` entries across all rows for a given metadata
 * field (`labels` or `annotations`), sorted alphabetically with counts.
 */
export function collectMetadataFacets(
  rows: readonly unknown[],
  field: "labels" | "annotations"
): MetadataFacetOption[] {
  const counts = new Map<string, { key: string; value: string; count: number }>();

  for (const row of rows) {
    const meta = (
      row as {
        metadata?: {
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
        };
      }
    )?.metadata;
    const record = meta?.[field];
    if (!record || typeof record !== "object") continue;

    for (const [key, rawValue] of Object.entries(record)) {
      const value = String(rawValue ?? "");
      const id = `${key}=${value}`;
      const existing = counts.get(id);
      if (existing) {
        existing.count++;
      } else {
        counts.set(id, { key, value, count: 1 });
      }
    }
  }

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  return [...counts.entries()]
    .sort((a, b) => collator.compare(a[0], b[0]))
    .map(([item, data]) => ({
      item,
      key: data.key,
      value: data.value,
      count: data.count,
    }));
}
