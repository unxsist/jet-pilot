import { V1CronJob } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<T extends V1CronJob>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [
    {
      label: "Trigger",
      handler: (row: T) => {
        const dialog: BaseDialogInterface = {
          title: "Trigger cron job",
          message: `Are you sure you want to manually trigger "${row.metadata?.name}"?`,
          buttons: [
            {
              label: "Cancel",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Trigger",
              handler: (dialog) => {
                Kubernetes.triggerCronJob(
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
  ];
}
