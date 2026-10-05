import { V1StatefulSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import { logsAction, restartAction, rolloutHistoryAction } from "./workload";

export function actions<
  T extends V1StatefulSet & {
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
    rolloutHistoryAction<any>(addTab),
    restartAction<any>(spawnDialog),
    ...scalableActions(addTab, spawnDialog, setSidePanelComponent, router),
  ];
}
