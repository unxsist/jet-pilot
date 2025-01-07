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
    | V1ReplicaSet
    | V1Deployment
    | V1ReplicationController
    | V1StatefulSet
>(
  addTab: any,
  spawnDialog: any,
  router: Router,
  context: string,
  kubeConfig: string
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
            context: context,
            kubeConfig: kubeConfig,
            objects: rows,
          },
          buttons: [],
        });
      },
    },
  ];
}
