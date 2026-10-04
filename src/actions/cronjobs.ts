import { V1CronJob } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";

export function actions<
  T extends V1CronJob & {
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
                  row.metadata.context,
                  row.metadata?.namespace || "",
                  row.metadata?.name || "",
                  row.metadata.kubeConfig
                )
                  .then(() => {
                    dialog.close();
                    const { toast } = useToast();
                    toast({
                      title: `Triggered ${row.metadata?.name}`,
                      description: "A job was created from the cron job.",
                      variant: "success",
                      autoDismiss: true,
                    });
                  })
                  .catch((error) => {
                    dialog.close();
                    const { toast } = useToast();

                    toast({
                      title: `Failed to trigger ${row.metadata?.name}`,
                      description: error?.message ?? String(error),
                      variant: "destructive",
                      duration: 15000,
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
