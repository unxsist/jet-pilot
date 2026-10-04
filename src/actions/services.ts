import { V1CronJob, V1Service } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<
  T extends V1Service & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return [
    {
      label: "Port Forward",
      handler: (row: T) => {
        spawnDialog({
          title: "Port Forward",
          message: "Forward ports from the pod to your local machine",
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
