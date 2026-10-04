import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { DialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/plugin-shell";
import { useToast } from "@/components/ui/toast";
import { error } from "@/lib/logger";

/*
 * Helm release rows are not Kubernetes objects; they carry the context they
 * were fetched from in `metadata` (injected by HelmResource aggregation).
 */
interface HelmReleaseRow {
  name: string;
  namespace: string;
  revision: number;
  metadata: { context: string; kubeConfig: string };
}

export function actions(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<HelmReleaseRow>[] {
  return [
    {
      label: "Rollback",
      isAvailable: (row) => row.revision > 1,
      handler: (row: HelmReleaseRow) => {
        spawnDialog({
          title: "Rollback Helm Release",
          message: "Please select the revision to rollback to",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/HelmRollback.vue")
          ),
          props: {
            context: row.metadata.context,
            namespace: row.namespace,
            kubeConfig: row.metadata.kubeConfig,
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
      massAction: true,
      handler: (rows: HelmReleaseRow[]) => {
        spawnDialog({
          title: "Delete Helm Release",
          message: `Are you sure you want to delete ${
            rows.length > 1 ? "releases" : rows[0].name
          }?`,
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
                rows.forEach((row) => {
                  const { toast } = useToast();

                  const command = Command.create("helm", [
                    "delete",
                    row.name,
                    "--kube-context",
                    row.metadata.context,
                    "--namespace",
                    row.namespace,
                    "--kubeconfig",
                    row.metadata.kubeConfig,
                  ]);

                  command.stdout.on("data", (data: string) => {
                    toast({
                      title: "Helm Release Deleted",
                      description: `${row.name} has been deleted`,
                    });
                  });

                  command.stderr.on("data", (e: string) => {
                    error(`Failed to delete Helm Release: ${e}`);
                    toast({
                      title: "Helm Release Delete Error",
                      description: `Failed to delete ${row.name}`,
                    });
                  });

                  command.spawn();
                  dialog.close();
                });
              },
            },
          ],
        });
      },
    },
  ];
}
