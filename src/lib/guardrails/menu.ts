/*
 * Row actions vs. the guardrails (pure, unit tested): which cluster a row
 * belongs to, what an action does (its `kind`, else inferred from the
 * label) and whether a read-only cluster blocks it. The tables hide blocked
 * actions from row menus and disable them in the selection bar.
 */
import type { RowAction } from "@/components/tables/types";
import { rowActionLabel } from "@/components/tables/keyboard";
import {
  actionKindForLabel,
  isBlocked,
  readOnlyReason,
  type ActionKind,
  type GuardedCluster,
} from "./policy";

export interface ClusterRef {
  context: string;
  kubeConfig?: string;
}

/** The cluster a table row was fetched from (rows carry it in metadata). */
export function rowClusterRef(row: unknown): ClusterRef | null {
  const metadata = (row as { metadata?: { context?: unknown; kubeConfig?: unknown } } | null)
    ?.metadata;
  if (typeof metadata?.context !== "string" || !metadata.context) return null;
  return {
    context: metadata.context,
    kubeConfig: typeof metadata.kubeConfig === "string" ? metadata.kubeConfig : undefined,
  };
}

export function rowActionKind<T>(action: RowAction<T>, row: T | null): ActionKind | undefined {
  return action.kind ?? actionKindForLabel(rowActionLabel(action, row));
}

/**
 * Why `action` can't run on `rows`: the reason of the first read-only
 * cluster among them that blocks it, else null.
 */
export function blockedReason<T>(
  action: RowAction<T>,
  rows: readonly T[],
  resolve: (ref: ClusterRef) => GuardedCluster
): string | null {
  const checked = new Set<string>();
  for (const row of rows) {
    const ref = rowClusterRef(row);
    const kind = ref ? rowActionKind(action, row) : undefined;
    if (!ref || !kind) continue;
    const key = `${kind}\u0000${ref.kubeConfig ?? ""}\u0000${ref.context}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const cluster = resolve(ref);
    if (isBlocked(kind, cluster)) return readOnlyReason(cluster);
  }
  return null;
}
