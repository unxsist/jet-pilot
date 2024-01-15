import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { KubernetesObject } from "@kubernetes/client-node";

export interface BaseRowAction<T> {
  label: string;
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
  context: string
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
            type: row.kind,
            name: row.metadata?.name,
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
            type: row.kind,
            name: row.metadata?.name,
          },
          "describe"
        );
      },
    },
  ];
}
