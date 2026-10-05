import { V1ReplicaSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";
import { logsAction } from "./workload";

export function actions<
  T extends V1ReplicaSet & {
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
    ...scalableActions(addTab, spawnDialog, setSidePanelComponent, router),
  ];
}
