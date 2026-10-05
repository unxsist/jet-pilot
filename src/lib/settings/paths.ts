/*
 * Dotted-path helpers for plain JSON objects (settings files): read, write
 * and delete "terminal.fontSize" style keys, deep equality and cloning.
 */

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const segments = (key: string) => key.split(".");

export function getPath(object: unknown, key: string): unknown {
  let current: unknown = object;
  for (const segment of segments(key)) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function hasPath(object: unknown, key: string): boolean {
  const parts = segments(key);
  const last = parts.pop()!;
  const parent = parts.length ? getPath(object, parts.join(".")) : object;
  return isPlainObject(parent) && Object.prototype.hasOwnProperty.call(parent, last);
}

/** Sets `key`, creating (or replacing non-object) parents. */
export function setPath(object: JsonObject, key: string, value: unknown): void {
  const parts = segments(key);
  const last = parts.pop()!;
  let current = object;
  for (const segment of parts) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment] as JsonObject;
  }
  current[last] = value;
}

/** Deletes `key` and the parents it leaves empty. */
export function deletePath(object: JsonObject, key: string): void {
  const parts = segments(key);
  const parents: JsonObject[] = [object];
  let current: unknown = object;
  for (const segment of parts.slice(0, -1)) {
    if (!isPlainObject(current)) return;
    current = current[segment];
    if (!isPlainObject(current)) return;
    parents.push(current);
  }
  delete parents[parents.length - 1]![parts[parts.length - 1]!];
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]!).length > 0) break;
    delete parents[i - 1]![parts[i - 1]!];
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/** A deep copy of JSON data (also unwraps Vue proxies). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Merges `source` into `target` recursively (plain objects only; source wins). */
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
