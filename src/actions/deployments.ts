import { V1Deployment } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<T extends V1Deployment>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [
    {
      label: "Logs",
      handler: (row: T) => {
        addTab(
          `logs_${row.metadata?.name}`,
          `${row.metadata?.name}`,
          defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")),
          {
            context: context,
            namespace: row.metadata?.namespace ?? "",
            kubeConfig: kubeConfig,
            object: `deployment/${row.metadata?.name}`,
          },
          "logs"
        );
      },
    },
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
    {
      label: "Restart",
      massAction: true,
      handler: (rows: T[]) => {
        const dialog: BaseDialogInterface = {
          title: "Restart deployment",
          message: `Are you sure you want to restart ${rows.length} deployment(s)?`,
          buttons: [
            {
              label: "Cancel",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Restart",
              handler: (dialog) => {
                rows.forEach((row) => {
                  Kubernetes.restartDeployment(
                    context,
                    row.metadata?.namespace || "",
                    row.metadata?.name || ""
                  )
                    .then(() => {
                      dialog.close();
                    })
                    .catch((error) => {
                      dialog.close();

                      const { toast } = useToast();

                      toast({
                        title: "An error occured",
                        description: error.message,
                        variant: "destructive",
                      });
                    });
                });
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
    ...scalableActions(
      addTab,
      spawnDialog,
      setSidePanelComponent,
      router,
      context,
      kubeConfig
    ),
  ];
}
