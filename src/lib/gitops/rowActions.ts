import { RowAction } from "@/components/tables/types";
import { deliveryKindOf } from "./kinds";

/*
 * Row actions of the GitOps kinds in their tables (src/actions/
 * kustomizations.ts, helmreleases.ts, applications.ts). The work happens in
 * @/lib/gitops/actions (guardrails, patch, progress), loaded on use.
 */
const gitopsActions = () => import("./actions");
const isDelivery = (row: unknown) => deliveryKindOf(row as { kind?: string; apiVersion?: string }) !== null;
const suspended = (row: unknown) => (row as { spec?: { suspend?: boolean } }).spec?.suspend === true;

export function fluxActions<T>(): RowAction<T>[] {
  return [
    {
      label: "Reconcile",
      kind: "reconcile",
      isAvailable: (row: T) => isDelivery(row) && !suspended(row),
      handler: async (row: T) => (await gitopsActions()).reconcile(row as any),
    },
    {
      label: "Reconcile with source",
      kind: "reconcile",
      isAvailable: (row: T) => isDelivery(row) && !suspended(row),
      handler: async (row: T) => (await gitopsActions()).reconcile(row as any, { withSource: true }),
    },
    {
      label: (row: T) => (suspended(row) ? "Resume" : "Suspend"),
      kind: "suspend",
      isAvailable: (row: T) => isDelivery(row),
      handler: async (row: T) => (await gitopsActions()).setSuspended(row as any, !suspended(row)),
    },
  ];
}

export function argoActions<T>(spawnDialog: any): RowAction<T>[] {
  return [
    {
      label: "Sync",
      kind: "sync",
      isAvailable: (row: T) => isDelivery(row),
      handler: async (row: T) => (await import("./ui")).openSyncDialog(spawnDialog, row),
    },
    {
      label: "Refresh",
      kind: "refresh",
      isAvailable: (row: T) => isDelivery(row),
      handler: async (row: T) => (await gitopsActions()).refresh(row as any),
    },
    {
      label: "Hard refresh",
      kind: "refresh",
      isAvailable: (row: T) => isDelivery(row),
      handler: async (row: T) => (await gitopsActions()).refresh(row as any, true),
    },
  ];
}
