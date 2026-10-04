import { BaseDialogInterface } from "@/providers/DialogProvider";
import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { KubernetesObject } from "@kubernetes/client-node";
import { formatResourceKind } from "@/lib/utils";
import { runCliForEach } from "@/actions/command";
import {
  describeRows,
  getResourceTabId,
  getResourceTabTitle,
} from "./identity";

/*
 * Rows fetched in (multi-)context mode carry the context + kubeconfig they
 * were fetched with in their metadata, so actions can target the right cluster.
 */
export type ContextAwareKubernetesObject = KubernetesObject & {
  metadata: KubernetesObject["metadata"] & {
    context: string;
    kubeConfig: string;
  };
};

export type ContextAwareVirtualService = VirtualService & {
  metadata: VirtualService["metadata"] & {
    context: string;
    kubeConfig: string;
  };
};

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

export function getDefaultActions<
  T extends ContextAwareKubernetesObject | ContextAwareVirtualService
>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  isGenericResource = false
): RowAction<T>[] {
  return [
    {
      label: "View details",
      handler: (row: T) => {
        setSidePanelComponent({
          title: `${row.kind}: ${row.metadata?.name}`,
          icon: formatResourceKind(row.kind || "").toLowerCase(),
          component: defineAsyncComponent(
            () => import("@/views/panels/Resource.vue")
          ),
          props: {
            resource: row,
          },
        });
      },
    },
    {
      label: "Edit YAML",
      handler: (row: T) => {
        addTab(
          getResourceTabId("edit", row),
          getResourceTabTitle(row),
          defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
          {
            context: row.metadata.context,
            namespace: row.metadata?.namespace,
            kubeConfig: row.metadata.kubeConfig,
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
          getResourceTabId("describe", row),
          getResourceTabTitle(row),
          defineAsyncComponent(() => import("@/views/Describe.vue")),
          {
            context: row.metadata.context,
            namespace: row.metadata?.namespace,
            kubeConfig: row.metadata.kubeConfig,
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
          title:
            rows.length === 1
              ? `Delete ${getResourceTabTitle(rows[0])}?`
              : `Delete ${rows.length} resources?`,
          message: "This cannot be undone.",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/ResourceList.vue")
          ),
          props: {
            lines: describeRows(rows),
          },
          buttons: [
            {
              label: "Cancel",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Delete",
              variant: "destructive",
              handler: (dialog) => {
                dialog.close();
                runCliForEach("kubectl", rows, {
                  args: (row) => {
                    const args = [
                      "delete",
                      `${row.kind}/${row.metadata?.name}`,
                      "--context",
                      row.metadata.context,
                    ];
                    if (row.metadata.kubeConfig) {
                      args.push("--kubeconfig", row.metadata.kubeConfig);
                    }
                    if (row.metadata?.namespace) {
                      args.push("--namespace", row.metadata.namespace);
                    }
                    return args;
                  },
                  label: (row) => getResourceTabTitle(row),
                  successVerb: "Deleted",
                  failureVerb: "delete",
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
