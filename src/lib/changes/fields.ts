/*
 * Structural diff of two specs as field changes, the same shape the
 * backend recorder stores (src-tauri/src/changes/diff.rs): lists of named
 * objects (containers, env, volumes) are matched by name and read
 * `[name]` in a path; other lists compare as one value. Pure.
 */

export interface FieldChange {
  /** Object keys, and `[name]` for an item of a named list. */
  path: string[];
  /** Absent when the field was added. */
  from?: unknown;
  /** Absent when the field was removed. */
  to?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nameOf = (item: unknown): string | undefined =>
  isObject(item) && typeof item.name === "string" ? item.name : undefined;

/* Every item is an object with a unique name (and there is at least one). */
const named = (list: unknown[]) => {
  const names = list.map(nameOf);
  return list.length > 0 && names.every((n) => n !== undefined) && new Set(names).size === names.length;
};

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]));
  }
  return false;
}

function walk(old: unknown, next: unknown, path: string[], out: FieldChange[]) {
  if (equal(old, next)) return;
  if (isObject(old) && isObject(next)) {
    const keys = [...new Set([...Object.keys(old), ...Object.keys(next)])].sort();
    for (const key of keys) walk(old[key], next[key], [...path, key], out);
    return;
  }
  if (Array.isArray(old) && Array.isArray(next) && named(old) && named(next)) {
    const names = [...old.map(nameOf), ...next.map(nameOf)].filter((n, i, all) => all.indexOf(n) === i) as string[];
    for (const name of names) {
      walk(
        old.find((item) => nameOf(item) === name),
        next.find((item) => nameOf(item) === name),
        [...path, `[${name}]`],
        out
      );
    }
    return;
  }
  out.push({
    path,
    ...(old === undefined ? {} : { from: old }),
    ...(next === undefined ? {} : { to: next }),
  });
}

/** The fields that differ between `old` and `next`, in a stable order. */
export function diffFields(old: unknown, next: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  walk(old, next, [], out);
  return out;
}

/** Rebuilds the two sides of field changes as objects (for a YAML diff). */
export function sides(fields: FieldChange[]): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const put = (root: Record<string, unknown>, path: string[], value: unknown) => {
    let node = root;
    path.forEach((segment, index) => {
      // `[api]` reads as `api` in the rebuilt object: names stay visible.
      const key = /^\[.*\]$/.test(segment) ? segment.slice(1, -1) : segment;
      if (index === path.length - 1) node[key] = value;
      else node = (node[key] = isObject(node[key]) ? node[key] : {}) as Record<string, unknown>;
    });
  };
  for (const field of fields) {
    if (field.from !== undefined) put(before, field.path, field.from);
    if (field.to !== undefined) put(after, field.path, field.to);
  }
  return { before, after };
}
