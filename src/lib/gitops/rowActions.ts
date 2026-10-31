import { RowAction } from "@/components/tables/types";
import { annotateArgs, kindRef, kubectlFor, mergePatchArgs } from "@/lib/kubectl/command";
import { deliveryKindOf } from "./kinds";
import { RECONCILE_ANNOTATION, REFRESH_ANNOTATION } from "./model";

/*
 * Row actions of the GitOps kinds in their tables (src/actions/
 * kustomizations.ts, helmreleases.ts, applications.ts). The work happens in
 * @/lib/gitops/actions (guardrails, patch, progress), loaded on use.
 */
const gitopsActions = () => import("./actions");
const isDelivery = (row: unknown) => deliveryKindOf(row as { kind?: string; apiVersion?: string }) !== null;
const suspended = (row: unknown) => (row as { spec?: { suspend?: boolean } }).spec?.suspend === true;

/* The same annotations and patches the actions apply. */
const annotateCommand = (row: unknown, annotations: Record<string, string>) =>
  kubectlFor(row as never, annotateArgs(kindRef(row as never), annotations));

export function fluxActions<T>(): RowAction<T>[] {
  return [
    {
      label: "Reconcile",
      kind: "reconcile",
      isAvailable: (row: T) => isDelivery(row) && !suspended(row),
      command: (row: T) => annotateCommand(row, { [RECONCILE_ANNOTATION]: new Date().toISOString() }),
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
      command: (row: T) =>
        kubectlFor(row as never, mergePatchArgs(kindRef(row as never), { spec: { suspend: !suspended(row) } })),
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
      command: (row: T) => annotateCommand(row, { [REFRESH_ANNOTATION]: "normal" }),
      handler: async (row: T) => (await gitopsActions()).refresh(row as any),
    },
    {
      label: "Hard refresh",
      kind: "refresh",
      isAvailable: (row: T) => isDelivery(row),
      command: (row: T) => annotateCommand(row, { [REFRESH_ANNOTATION]: "hard" }),
      handler: async (row: T) => (await gitopsActions()).refresh(row as any, true),
    },
  ];
}
