import { V1ReplicaSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";

export function actions<T extends V1ReplicaSet>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [...scalableActions(addTab, spawnDialog, router, context, kubeConfig)];
}
