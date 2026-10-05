/**
 * Merges a parsed settings file over the defaults.
 *
 * Top-level keys from the file win, except that sections whose default is a
 * plain object (e.g. `appearance`, `updates`) are merged one level deep, so
 * keys added to a section in a newer release keep their default for users
 * whose settings file predates them. A section of the wrong type in the file
 * (say `appearance: "dark"`) falls back to the default section. Keys the
 * defaults don't know are kept, so a downgrade doesn't drop them.
 */
export function mergeSettings<T extends object>(defaults: T, stored: unknown): T {
  const merged: Record<string, unknown> = {
    ...(defaults as Record<string, unknown>),
  };
  for (const [key, fallback] of Object.entries(merged)) {
    if (isPlainObject(fallback)) {
      merged[key] = { ...fallback };
    }
  }
  if (!isPlainObject(stored)) {
    return merged as T;
  }

  for (const [key, value] of Object.entries(stored)) {
    const fallback = (defaults as Record<string, unknown>)[key];
    if (isPlainObject(fallback)) {
      if (isPlainObject(value)) {
        merged[key] = { ...fallback, ...value };
      }
    } else {
      merged[key] = value;
    }
  }

  return merged as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
