import {
  V1Deployment,
  V1ReplicaSet,
  V1ReplicationController,
  V1StatefulSet,
} from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";

export function actions<
  T extends
    | (V1ReplicaSet & { metadata: { context: string; kubeConfig: string } })
    | (V1Deployment & { metadata: { context: string; kubeConfig: string } })
    | (V1ReplicationController & {
        metadata: { context: string; kubeConfig: string };
      })
    | (V1StatefulSet & { metadata: { context: string; kubeConfig: string } })
>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return [
    {
      label: "Scale",
      massAction: true,
      handler: (rows: T[]) => {
        spawnDialog({
          title: `Scale ${rows[0].kind}s`,
          message: "Please enter desired number of replicas",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/ScaleResource.vue")
          ),
          props: {
            objects: rows,
          },
          buttons: [],
        });
      },
    },
  ];
}
