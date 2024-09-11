import { V1Node } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/api/shell";
import { useToast } from "@/components/ui/toast";

export function actions<T extends V1Node>(
  addTab: any,
  spawnDialog: any,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  const isCordoned = (row: T) => {
    return row.spec?.taints?.find((t) => t.effect === "NoSchedule");
  };

  return [
    {
      label: (row: T) => {
        return isCordoned(row) ? "Uncordon" : "Cordon";
      },
      handler: (row: T) => {
        const dialog: BaseDialogInterface = {
          title: isCordoned(row) ? "Uncordon" : "Cordon",
          message: isCordoned(row)
            ? `Are you sure you want to uncordon ${row.metadata?.name}?`
            : `Are you sure you want to cordon ${row.metadata?.name}?`,
          buttons: [
            {
              label: "Cancel",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: isCordoned(row) ? "Uncordon" : "Cordon",
              handler: (dialog) => {
                const command = new Command("kubectl", [
                  isCordoned(row) ? "uncordon" : "cordon",
                  `${row.metadata?.name}`,
                  "--context",
                  context,
                  "--kubeconfig",
                  kubeConfig,
                ]);

                command.stderr.on("data", (error: string) => {
                  console.log(error);
                });

                command.spawn();
                dialog.close();
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
    // drain node
    {
      label: "Drain",
      handler: (row: T) => {
        const dialog: BaseDialogInterface = {
          title: "Drain",
          message: `Are you sure you want to drain ${row.metadata?.name}?`,
          buttons: [
            {
              label: "Cancel",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Drain",
              handler: (dialog) => {
                const command = new Command("kubectl", [
                  "drain",
                  `${row.metadata?.name}`,
                  "--force",
                  "--ignore-daemonsets",
                  "--delete-local-data",
                  "--context",
                  context,
                  "--kubeconfig",
                  kubeConfig,
                ]);

                command.stderr.on("data", (error: string) => {
                  console.log(error);
                });

                command.once("close", (result: any) => {
                  const { toast } = useToast();

                  if (result.code === 0) {
                    toast({
                      title: `Node drain`,
                      description: `Node ${row.metadata?.name} successfully drained`,
                    });
                  } else {
                    toast({
                      title: `Node drain`,
                      description: `Node ${row.metadata?.name} failed to drain`,
                    });
                  }
                });
                command.spawn();
                dialog.close();
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
  ];
}
