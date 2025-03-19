import { V1CronJob, V1Service } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<T extends V1Service>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router,
  context: string,
  kubeConfig: string
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
            context: context,
            namespace: row.metadata?.namespace ?? "",
            kubeConfig: kubeConfig,
            object: row,
          },
          buttons: [],
        });
      },
    },
  ];
}
