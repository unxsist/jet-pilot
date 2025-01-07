import { V1Node } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/plugin-shell";
import { useToast } from "@/components/ui/toast";
import { Router } from "vue-router";

export function actions<T extends V1Node>(
  addTab: any,
  spawnDialog: any,
  router: Router,
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
                const command = Command.create("kubectl", [
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
    {
      label: "Drain",
      massAction: true,
      handler: (rows: T[]) => {
        const dialog: BaseDialogInterface = {
          title: "Drain",
          message: `Are you sure you want to drain ${
            rows.length > 1 ? "nodes" : rows[0].metadata?.name
          }?`,
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
                rows.forEach((row) => {
                  const command = Command.create("kubectl", [
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
