/**
 * Matches a Kubernetes metadata map (labels or annotations) against a filter
 * query. Supports comma- or space-separated terms:
 * - `key=value` or `key==value` (exact match, or substring when not exact)
 * - `key!=value` (key absent or value differs)
 * - `!key` (key absent)
 * - `term` (substring match against `key=value`, `key`, or `value`, case-insensitive)
 */
export function matchesMetadataQuery(
  entries: Record<string, string> | undefined | null,
  query: string
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  const map = entries ?? {};
  const pairs = Object.entries(map);

  const terms = trimmed
    .split(/[,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (terms.length === 0) return true;

  return terms.every((term) => {
    const notEqIdx = term.indexOf("!=");
    if (notEqIdx > 0) {
      const k = term.slice(0, notEqIdx).trim().toLowerCase();
      const v = term.slice(notEqIdx + 2).trim().toLowerCase();
      return !pairs.some(
        ([ek, ev]) => ek.toLowerCase() === k && ev.toLowerCase() === v
      );
    }

    const eqMatch = term.match(/^([^=!]+)==?(.*)$/);
    if (eqMatch) {
      const k = eqMatch[1].trim().toLowerCase();
      const v = eqMatch[2].trim().toLowerCase();
      return pairs.some(([ek, ev]) => {
        const keyMatches =
          ek.toLowerCase() === k || ek.toLowerCase().includes(k);
        if (!v) return keyMatches;
        return (
          keyMatches &&
          (ev.toLowerCase() === v || ev.toLowerCase().includes(v))
        );
      });
    }

    if (term.startsWith("!") && term.length > 1) {
      const needle = term.slice(1).trim().toLowerCase();
      return !pairs.some(([ek]) => ek.toLowerCase().includes(needle));
    }

    const needle = term.toLowerCase();
    return pairs.some(
      ([ek, ev]) =>
        ek.toLowerCase().includes(needle) ||
        ev.toLowerCase().includes(needle) ||
        `${ek}=${ev}`.toLowerCase().includes(needle)
    );
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
