import { KubernetesObject } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import {
  describeRows,
  getResourceTabId,
  getResourceTabTitle,
} from "@/components/tables/identity";
import { clusterArgs, objectRef, workloadSelector } from "@/lib/workloads";
import { rolloutArgs } from "@/lib/rollout";
import { confirmDialog, guard, rowTargets } from "@/lib/guardrails/guard";
import { kubectlFor, selectorLogsArgs } from "@/lib/kubectl/command";
import { isRolloutKind, type RolloutRef } from "@/lib/rolloutFollow";
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

/* Every pod of the workload, by its selector (kubectl logs deployment/x reads one pod). */
const logsCommand = (row: WorkloadRow, previous = false) => {
  const selector = workloadSelector(row as never);
  return selector ? kubectlFor(row, selectorLogsArgs(selector, previous)) : null;
};

export function logsAction<T extends WorkloadRow>(addTab: any): RowAction<T> {
  return {
    label: "Logs",
    command: (row: T) => logsCommand(row),
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
    command: (row: T) =>
      kubectlFor(row, ["rollout", "history", objectRef(row.kind ?? "", row.metadata.name ?? "")]),
    handler: (row: T) => openRolloutHistory(addTab, row),
  };
}

const kindLabel = (rows: WorkloadRow[]) =>
  (rows[0]?.kind ?? "workload").toLowerCase();

/** The rollout a change to `row` starts (Deployments, StatefulSets, DaemonSets). */
export const rolloutRefs = (row: {
  kind?: string;
  metadata?: { context: string; kubeConfig: string; namespace?: string; name?: string };
}): RolloutRef[] =>
  isRolloutKind(row.kind) && row.metadata
    ? [
        {
          context: row.metadata.context,
          kubeConfig: row.metadata.kubeConfig,
          namespace: row.metadata.namespace ?? "",
          kind: row.kind,
          name: row.metadata.name ?? "",
        },
      ]
    : [];

const rolloutCommand = (row: WorkloadRow, verb: "restart" | "pause" | "resume") =>
  kubectlFor(row, rolloutArgs(verb, row.kind ?? "", row.metadata.name ?? ""));

/** `kubectl rollout restart` with a confirmation listing the objects. */
export function restartAction<T extends WorkloadRow>(
  spawnDialog: (dialog: BaseDialogInterface) => void
): RowAction<T> {
  return {
    label: "Restart",
    kind: "restart",
    massAction: true,
    command: (row: T) => rolloutCommand(row, "restart"),
    handler: async (rows: T[]) => {
      const commands = rows.map((row) => rolloutCommand(row, "restart"));
      const confirmed = await guard("restart", rowTargets(rows), {
        commands,
        confirm: () =>
          confirmDialog(spawnDialog, {
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
            commands,
            confirmLabel: "Restart",
          }),
      });
      if (!confirmed) return;
      runCliForEach("kubectl", rows, {
        args: (row) => [
          ...rolloutArgs("restart", row.kind ?? "", row.metadata.name ?? ""),
          ...clusterArgs(target(row)),
        ],
        label: (row) => getResourceTabTitle(row),
        successVerb: "Restarted",
        failureVerb: "restart",
        guarded: true,
        rollouts: rolloutRefs,
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
    command: (row: T) => rolloutCommand(row, paused(row) ? "resume" : "pause"),
    handler: async (row: T) => {
      const resume = paused(row);
      const commands = [rolloutCommand(row, resume ? "resume" : "pause")];
      const confirmed = await guard(resume ? "resume" : "pause", rowTargets([row]), {
        commands,
        confirm: () =>
          confirmDialog(spawnDialog, {
            title: `${resume ? "Resume" : "Pause"} rollout of ${row.metadata.name}?`,
            message: resume
              ? "Pending template changes are rolled out."
              : "Template changes are not rolled out until the rollout is resumed. Scaling still works.",
            commands,
            confirmLabel: resume ? "Resume" : "Pause",
          }),
      });
      if (!confirmed) return;
      runCliForEach("kubectl", [row], {
        args: (r) => [
          ...rolloutArgs(resume ? "resume" : "pause", r.kind ?? "", r.metadata.name ?? ""),
          ...clusterArgs(target(r)),
        ],
        label: (r) => getResourceTabTitle(r),
        successVerb: resume ? "Resumed rollout of" : "Paused rollout of",
        failureVerb: resume ? "resume the rollout of" : "pause the rollout of",
        guarded: true,
      });
    },
  };
}
