/*
 * Identity helpers for table rows.
 *
 * Rows are fetched across multiple contexts, so neither the row index nor the
 * object name is unique: identities always include the context the row was
 * fetched from (tagged in `metadata.context` by the views).
 */

interface IdentifiableRow {
  kind?: string;
  /* Helm rows are not Kubernetes objects: name + namespace live top-level. */
  name?: string;
  namespace?: string;
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    context?: string;
  };
}

const asRow = (row: unknown): IdentifiableRow | null =>
  row && typeof row === "object" ? (row as IdentifiableRow) : null;

/**
 * Stable identity of a context-tagged row: `<context>/<uid>`, falling back to
 * `<context>/<namespace>/<name>` for rows without a uid (Helm releases and
 * charts). Returns null for rows that are not context-tagged (e.g. log lines),
 * callers should fall back to the row index for those.
 */
export function getRowIdentity(row: unknown): string | null {
  const r = asRow(row);
  const context = r?.metadata?.context;
  if (!r || typeof context !== "string") {
    return null;
  }

  if (r.metadata?.uid) {
    return `${context}/${r.metadata.uid}`;
  }

  const name = r.metadata?.name ?? r.name;
  if (!name) {
    return null;
  }

  const namespace = r.metadata?.namespace ?? r.namespace ?? "";
  return `${context}/${namespace}/${name}`;
}

/**
 * Tab id for an action on a row (edit, describe, logs, shell, ...). Includes
 * context + namespace + kind + name so equally named objects in other
 * namespaces / clusters get their own tab.
 */
export function getResourceTabId(
  action: string,
  row: unknown,
  ...extra: (string | undefined)[]
): string {
  const r = asRow(row) ?? {};
  return [
    action,
    r.metadata?.context ?? "",
    r.metadata?.namespace ?? r.namespace ?? "",
    r.kind ?? "",
    r.metadata?.name ?? r.name ?? "",
    ...extra.filter((part): part is string => !!part),
  ].join("/");
}

/** Human readable tab title, e.g. `deployment/nginx` or `pod/web-0/app`. */
export function getResourceTabTitle(
  row: unknown,
  ...extra: (string | undefined)[]
): string {
  const r = asRow(row) ?? {};
  const name = r.metadata?.name ?? r.name ?? "";
  return [
    r.kind ? `${r.kind.toLowerCase()}/${name}` : name,
    ...extra.filter((part): part is string => !!part),
  ].join("/");
}

export interface CreateTarget {
  context: string;
  namespace: string;
  kubeConfig: string;
}

/**
 * Where a newly created object goes: the primary context and its single
 * active namespace, or "default" when several (or all) namespaces are active.
 * Returns plain values (not refs) so the editor tab keeps its target when the
 * selection changes later on.
 */
export function resolveCreateTarget(
  primaryContext: string,
  primaryKubeConfig: string,
  contexts: Map<string, string[]>,
  contextKubeConfigMapping: Map<string, string>
): CreateTarget {
  const namespaces = contexts.get(primaryContext) || [];

  return {
    context: primaryContext,
    namespace:
      namespaces.length === 1 && namespaces[0] !== "all" && namespaces[0]
        ? namespaces[0]
        : // Several or all namespaces: let the manifest decide (kubectl only
          // enforces --namespace when it is non-empty; the create template
          // falls back to "default").
          "",
    kubeConfig:
      contextKubeConfigMapping.get(primaryContext) || primaryKubeConfig,
  };
}

/**
 * Lines identifying the given rows for confirmation dialogs, e.g.
 * `pod/web-0 (prod › default)`. Context / namespace are only added when they
 * help to tell rows apart.
 */
export function describeRows(rows: unknown[], limit = 10): string[] {
  const parsed = rows.map((row) => asRow(row) ?? {});
  const contexts = new Set(parsed.map((r) => r.metadata?.context ?? ""));
  const namespaces = new Set(
    parsed.map((r) => r.metadata?.namespace ?? r.namespace ?? "")
  );
  const showContext = contexts.size > 1;
  const showNamespace = showContext || namespaces.size > 1;

  const lines = parsed.slice(0, limit).map((r) => {
    const scope = [
      showContext ? r.metadata?.context : undefined,
      showNamespace ? r.metadata?.namespace ?? r.namespace : undefined,
    ].filter(Boolean);

    return `${getResourceTabTitle(r)}${
      scope.length ? ` (${scope.join(" › ")})` : ""
    }`;
  });

  if (rows.length > limit) {
    lines.push(`… and ${rows.length - limit} more`);
  }

  return lines;
}
