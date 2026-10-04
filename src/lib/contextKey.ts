/**
 * A kube context is only unique within its kubeconfig: two kubeconfigs can
 * both define `kind-kind` or `default`. Everything that identifies a context
 * (list keys, lookups, activation state) must therefore use the kubeconfig
 * path + context name pair, while kubectl itself keeps receiving the plain
 * context name (`--context <name> --kubeconfig <path>`).
 */
export interface ContextRef {
  context: string;
  kubeConfig: string;
}

/* NUL never appears in a file path or a context name. */
const SEPARATOR = "\u0000";

/** Stable identity for a (kubeconfig, context) pair. */
export function contextKey(context: string, kubeConfig: string): string {
  return `${kubeConfig}${SEPARATOR}${context}`;
}

/** Inverse of {@link contextKey}. */
export function parseContextKey(key: string): ContextRef {
  const index = key.indexOf(SEPARATOR);
  if (index === -1) {
    return { context: key, kubeConfig: "" };
  }

  return {
    kubeConfig: key.slice(0, index),
    context: key.slice(index + SEPARATOR.length),
  };
}

/**
 * Whether two references point at the same context. An empty kubeconfig on
 * either side (legacy settings, or callers that only know the name) matches
 * any kubeconfig.
 */
export function isSameContext(a: ContextRef, b: ContextRef): boolean {
  if (a.context !== b.context) {
    return false;
  }

  return !a.kubeConfig || !b.kubeConfig || a.kubeConfig === b.kubeConfig;
}

/**
 * Next namespace selection of a context after toggling `namespace` in the
 * context switcher.
 *
 * - `"all"` toggles between all namespaces and none (deactivated).
 * - Toggling a single namespace while "all" is selected expands "all" to the
 *   full namespace list first, so individual namespaces can be deselected.
 * - Selecting every known namespace folds back to `["all"]`.
 */
export function toggleNamespaceSelection(
  current: string[],
  available: string[],
  namespace: string
): string[] {
  if (namespace === "all") {
    return current.includes("all") ? [] : ["all"];
  }

  let next = current.includes("all") ? [...available] : [...current];

  if (next.includes(namespace)) {
    next = next.filter((ns) => ns !== namespace);
  } else {
    next = [...next, namespace];
  }

  if (available.length > 0 && available.every((ns) => next.includes(ns))) {
    return ["all"];
  }

  return next;
}

/**
 * Case-insensitive "contains" filter used by the switcher search inputs.
 */
export function matchesFilter(value: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === "" || value.toLowerCase().includes(needle);
}
