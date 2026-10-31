import { V1Service } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { openWorkloadLogs } from "./workload";
import { kubectlFor, localPortFor, portForwardArgs, selectorLogsArgs } from "@/lib/kubectl/command";
import { workloadSelector } from "@/lib/workloads";

export function actions<
  T extends V1Service & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  spawnDialog: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _setSidePanelComponent: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _router: Router
): RowAction<T>[] {
  return [
    {
      label: "Logs",
      // Services without a selector (external endpoints) have no pods.
      isAvailable: (row: T) =>
        Object.keys(row.spec?.selector ?? {}).length > 0,
      command: (row: T) => {
        const selector = workloadSelector(row as never);
        return selector ? kubectlFor(row, selectorLogsArgs(selector)) : null;
      },
      handler: (row: T) => openWorkloadLogs(addTab, row as any),
    },
    {
      label: "Port Forward",
      command: (row: T) => {
        const port = row.spec?.ports?.[0]?.port;
        return port
          ? kubectlFor(row, portForwardArgs(`service/${row.metadata?.name}`, [{ local: localPortFor(port), remote: port }]))
          : null;
      },
      handler: (row: T) => {
        spawnDialog({
          title: "Port forward",
          message:
            "Reach a pod behind this service from your computer. The forward follows rollouts.",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/PortForward.vue")
          ),
          props: {
            context: row.metadata.context,
            namespace: row.metadata?.namespace ?? "",
            kubeConfig: row.metadata.kubeConfig,
            object: row,
          },
          buttons: [],
        });
      },
    },
  ];
}
