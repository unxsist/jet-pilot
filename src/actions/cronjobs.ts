import { V1CronJob } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { Kubernetes } from "@/services/Kubernetes";
import { useToast } from "@/components/ui/toast";
import { confirmDialog, guard, rowTargets } from "@/lib/guardrails/guard";
import { kubectlFor, triggerCronJobArgs } from "@/lib/kubectl/command";

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
      kind: "cronjob-trigger",
      command: (row: T) => kubectlFor(row, triggerCronJobArgs(row.metadata?.name ?? "")),
      handler: async (row: T) => {
        const commands = [kubectlFor(row, triggerCronJobArgs(row.metadata?.name ?? ""))];
        const confirmed = await guard("cronjob-trigger", rowTargets([row]), {
          commands,
          confirm: () =>
            confirmDialog(spawnDialog, {
              title: "Trigger cron job",
              message: `Are you sure you want to manually trigger "${row.metadata?.name}"?`,
              commands,
              confirmLabel: "Trigger",
            }),
        });
        if (!confirmed) return;
        const { toast } = useToast();
        Kubernetes.triggerCronJob(
          row.metadata.context,
          row.metadata?.namespace || "",
          row.metadata?.name || "",
          row.metadata.kubeConfig,
          { guarded: true }
        )
          .then(() => {
            toast({
              title: `Triggered ${row.metadata?.name}`,
              description: "A job was created from the cron job.",
              variant: "success",
              autoDismiss: true,
            });
          })
          .catch((error) => {
            toast({
              title: `Failed to trigger ${row.metadata?.name}`,
              description: error?.message ?? String(error),
              variant: "destructive",
              duration: 15000,
            });
          });
      },
    },
  ];
}
