import { V1StatefulSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<T extends V1StatefulSet>(
  addTab: any,
  spawnDialog: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [
    {
      label: "Restart",
      handler: (row) => {
        const dialog: BaseDialogInterface = {
          title: "Restart statefulset",
          message: `Are you sure you want to restart statefulset ${row.metadata?.name}?`,
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
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
    ...scalableActions(addTab, spawnDialog, router, context, kubeConfig),
  ];
}
