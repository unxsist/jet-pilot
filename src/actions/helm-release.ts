import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { DialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/api/shell";
import { useToast } from "@/components/ui/toast";

export function actions(
  addTab: any,
  spawnDialog: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [
    {
      label: "Rollback",
      isAvailable: (row) => row.revision > 1,
      handler: (row: any) => {
        spawnDialog({
          title: "Rollback Helm Release",
          message: "Please select the revision to rollback to",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/HelmRollback.vue")
          ),
          props: {
            context: context,
            namespace: row.namespace,
            kubeConfig: kubeConfig,
            release: row,
          },
          buttons: [],
        });
      },
    },
    // {
    //   label: "Upgrade",
    //   handler: (row: any) => {},
    // },
    {
      label: "Delete",
      handler: (row: any) => {
        spawnDialog({
          title: "Delete Helm Release",
          message: `Are you sure you want to delete ${row.name}?`,
          buttons: [
            {
              label: "Cancel",
              handler: (dialog: DialogInterface) => {
                dialog.close();
              },
            },
            {
              label: "Delete",
              handler: (dialog: DialogInterface) => {
                const { toast } = useToast();

                const command = new Command("helm", [
                  "delete",
                  row.name,
                  "--kube-context",
                  context,
                  "--namespace",
                  row.namespace,
                  "--kubeconfig",
                  kubeConfig,
                ]);

                command.stdout.on("data", (data: string) => {
                  toast({
                    title: "Helm Release Deleted",
                    description: `${row.name} has been deleted`,
                  });
                });

                command.stderr.on("data", (error: string) => {
                  console.log(error);
                  toast({
                    title: "Helm Release Delete Error",
                    description: `Failed to delete ${row.name}`,
                  });
                });

                command.spawn();
                dialog.close();
              },
            },
          ],
        });
      },
    },
  ];
}
