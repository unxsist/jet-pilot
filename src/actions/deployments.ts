import { V1Deployment } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import {
  logsAction,
  pauseResumeAction,
  restartAction,
  rolloutHistoryAction,
} from "./workload";

export function actions<
  T extends V1Deployment & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return [
    logsAction<any>(addTab),
    {
      label: "Port Forward",
      handler: (row: T) => {
        spawnDialog({
          title: "Port Forward",
          message: "Forward ports from the pod to your local machine",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/PortForward.vue")
          ),
          props: {
            context: row.metadata.context,
            namespace: row.metadata?.namespace ?? "",
            kubeConfig: row.metadata.kubeConfig,
            object: row,
          },
          buttons: [],
        });
      },
    },
    rolloutHistoryAction<any>(addTab),
    restartAction<any>(spawnDialog),
    pauseResumeAction<any>(spawnDialog),
    ...scalableActions(addTab, spawnDialog, setSidePanelComponent, router),
  ];
}
