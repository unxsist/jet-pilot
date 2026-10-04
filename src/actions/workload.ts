import { KubernetesObject } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { BaseDialogInterface, DialogInterface } from "@/providers/DialogProvider";
import {
  describeRows,
  getResourceTabId,
  getResourceTabTitle,
} from "@/components/tables/identity";
import { clusterArgs } from "@/lib/workloads";
import { rolloutArgs } from "@/lib/rollout";
import { runCliForEach } from "./command";

/*
 * Actions shared by workload kinds (Deployments, StatefulSets, DaemonSets,
 * ReplicaSets, Jobs, Services): logs across all pods, rollout history,
 * restart and pause / resume. Not a resource of its own: GenericResource
 * only loads `actions/<resource>.ts`.
 */

export type WorkloadRow = KubernetesObject & {
  metadata: NonNullable<KubernetesObject["metadata"]> & {
    context: string;
    kubeConfig: string;
  };
  spec?: { paused?: boolean };
};

const target = (row: WorkloadRow) => ({
  context: row.metadata.context,
  namespace: row.metadata.namespace ?? "",
  kubeConfig: row.metadata.kubeConfig,
});

/** Opens the log viewer for every pod of the workload. */
export function openWorkloadLogs(addTab: any, row: WorkloadRow, previous = false) {
  addTab(
    getResourceTabId(previous ? "logs-previous" : "logs", row),
    getResourceTabTitle(row),
    defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")),
    {
      ...target(row),
      object: `${(row.kind ?? "").toLowerCase()}/${row.metadata.name}`,
      previous,
    },
    "logs"
  );
}

export function logsAction<T extends WorkloadRow>(addTab: any): RowAction<T> {
  return {
    label: "Logs",
    options: (row: T) => [
      { label: "All pods", handler: () => openWorkloadLogs(addTab, row) },
      {
        label: "All pods (previous containers)",
        handler: () => openWorkloadLogs(addTab, row, true),
      },
    ],
  };
}

export function openRolloutHistory(addTab: any, row: WorkloadRow) {
  addTab(
    getResourceTabId("rollout", row),
    `${getResourceTabTitle(row)} history`,
    defineAsyncComponent(() => import("@/views/RolloutHistory.vue")),
    {
      ...target(row),
      kind: row.kind,
      name: row.metadata.name,
    },
    "history"
  );
}

export function rolloutHistoryAction<T extends WorkloadRow>(
  addTab: any
): RowAction<T> {
  return {
    label: "Rollout history",
    handler: (row: T) => openRolloutHistory(addTab, row),
  };
}

const kindLabel = (rows: WorkloadRow[]) =>
  (rows[0]?.kind ?? "workload").toLowerCase();

/** `kubectl rollout restart` with a confirmation listing the objects. */
export function restartAction<T extends WorkloadRow>(
  spawnDialog: (dialog: BaseDialogInterface) => void
): RowAction<T> {
  return {
    label: "Restart",
    massAction: true,
    handler: (rows: T[]) => {
      spawnDialog({
        title:
          rows.length === 1
            ? `Restart ${getResourceTabTitle(rows[0])}?`
            : `Restart ${rows.length} ${kindLabel(rows)}s?`,
        message:
          "All pods are replaced through a rolling update, following the update strategy.",
        component: defineAsyncComponent(
          () => import("@/views/dialogs/ResourceList.vue")
        ),
        props: { lines: describeRows(rows) },
        buttons: [
          {
            label: "Cancel",
            variant: "ghost",
            handler: (dialog: DialogInterface) => dialog.close(),
          },
          {
            label: "Restart",
            handler: (dialog: DialogInterface) => {
              dialog.close();
              runCliForEach("kubectl", rows, {
                args: (row) => [
                  ...rolloutArgs("restart", row.kind ?? "", row.metadata.name ?? ""),
                  ...clusterArgs(target(row)),
                ],
                label: (row) => getResourceTabTitle(row),
                successVerb: "Restarted",
                failureVerb: "restart",
              });
            },
          },
        ],
      });
    },
  };
}

/** Pause / resume a Deployment rollout (only Deployments support it). */
export function pauseResumeAction<T extends WorkloadRow>(
  spawnDialog: (dialog: BaseDialogInterface) => void
): RowAction<T> {
  const paused = (row: T) => row.spec?.paused === true;
  return {
    label: (row: T) => (paused(row) ? "Resume rollout" : "Pause rollout"),
    handler: (row: T) => {
      const resume = paused(row);
      spawnDialog({
        title: `${resume ? "Resume" : "Pause"} rollout of ${row.metadata.name}?`,
        message: resume
          ? "Pending template changes are rolled out."
          : "Template changes are not rolled out until the rollout is resumed. Scaling still works.",
        buttons: [
          {
            label: "Cancel",
            variant: "ghost",
            handler: (dialog: DialogInterface) => dialog.close(),
          },
          {
            label: resume ? "Resume" : "Pause",
            handler: (dialog: DialogInterface) => {
              dialog.close();
              runCliForEach("kubectl", [row], {
                args: (r) => [
                  ...rolloutArgs(resume ? "resume" : "pause", r.kind ?? "", r.metadata.name ?? ""),
                  ...clusterArgs(target(r)),
                ],
                label: (r) => getResourceTabTitle(r),
                successVerb: resume ? "Resumed rollout of" : "Paused rollout of",
                failureVerb: resume ? "resume the rollout of" : "pause the rollout of",
              });
            },
          },
        ],
      });
    },
  };
}
