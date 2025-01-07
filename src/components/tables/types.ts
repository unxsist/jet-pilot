import { BaseDialogInterface } from "@/providers/DialogProvider";
import { Command } from "@tauri-apps/plugin-shell";
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
  massAction?: never;
  isAvailable?: (row: T) => boolean;
  handler: (row: T) => void;
}

export interface MassWithHandler<T> extends BaseRowAction<T> {
  massAction: true;
  options?: never;
  handler: (rows: T[]) => void;
}

export type RowAction<T> = WithOptions<T> | WithHandler<T> | MassWithHandler<T>;

export function getDefaultActions<T extends KubernetesObject | VirtualService>(
  addTab: any,
  spawnDialog: any,
  context: string,
  kubeConfig: string,
  isGenericResource = false
): RowAction<T>[] {
  return [
    {
      label: "Edit YAML",
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
      handler: (row: T) => {
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
      massAction: true,
      handler: (rows: T[]) => {
        const dialog: BaseDialogInterface = {
          title: "Delete",
          message: `Are you sure you want to delete ${rows.length} selected items?`,
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
                rows.forEach((row) => {
                  const command = Command.create("kubectl", [
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
