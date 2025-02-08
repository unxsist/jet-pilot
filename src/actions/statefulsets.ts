import { V1StatefulSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";
import { error } from "@/lib/logger";

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
      massAction: true,
      handler: (rows: T[]) => {
        const dialog: BaseDialogInterface = {
          title: "Restart statefulset",
          message: `Are you sure you want to restart statefulsets?`,
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
                    .catch((e) => {
                      error(`Failed to restart statefulset: ${e.message}`);
                      dialog.close();

                      const { toast } = useToast();

                      toast({
                        title: "An error occured",
                        description: e.message,
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
    ...scalableActions(addTab, spawnDialog, router, context, kubeConfig),
  ];
}
