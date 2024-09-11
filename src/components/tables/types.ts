import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/api/shell";
import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { KubernetesObject } from "@kubernetes/client-node";

export interface BaseRowAction<T> {
  label: string | ((row: T) => string);
}

export interface WithOptions<T> extends BaseRowAction<T> {
  options: (row: T) => WithHandler<T>[];
  handler?: never;
}

export interface WithHandler<T> extends BaseRowAction<T> {
  options?: never;
  handler: (row: T) => void;
}

export type RowAction<T> = WithOptions<T> | WithHandler<T>;

export function getDefaultActions<T extends KubernetesObject | VirtualService>(
  addTab: any,
  spawnDialog: any,
  context: string,
  kubeConfig: string,
  isGenericResource = false
): RowAction<T>[] {
  return [
    {
      label: "Edit",
      handler: (row: T) => {
        addTab(
          `edit_${row.metadata?.name}`,
          `${row.metadata?.name}`,
          defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
          {
            context: context,
            namespace: row.metadata?.namespace,
            kubeConfig: kubeConfig,
            type: row.kind,
            name: row.metadata?.name,
            useKubeCtl: isGenericResource,
          },
          "edit"
        );
      },
    },
    {
      label: "Describe",
      handler: (row) => {
        addTab(
          `describe_${row.metadata?.name}`,
          `${row.metadata?.name}`,
          defineAsyncComponent(() => import("@/views/Describe.vue")),
          {
            context: context,
            namespace: row.metadata?.namespace,
            kubeConfig: kubeConfig,
            type: row.kind,
            name: row.metadata?.name,
          },
          "describe"
        );
      },
    },
    {
      label: "Delete",
      handler: (row) => {
        const dialog: BaseDialogInterface = {
          title: "Delete",
          message: `Are you sure you want to delete ${row.metadata?.name}?`,
          buttons: [
            {
              label: "Cancel",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Delete",
              handler: (dialog) => {
                const command = new Command("kubectl", [
                  "delete",
                  `${row.kind}/${row.metadata?.name}`,
                  "--context",
                  context,
                  "--namespace",
                  row.metadata?.namespace || "",
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
  ];
}
