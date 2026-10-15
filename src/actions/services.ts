import { V1Service } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { openWorkloadLogs } from "./workload";

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
      handler: (row: T) => openWorkloadLogs(addTab, row as any),
    },
    {
      label: "Port Forward",
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
