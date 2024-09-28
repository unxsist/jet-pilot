import { V1StatefulSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { actions as scalableActions } from "./scalables";

export function actions<T extends V1StatefulSet>(
  addTab: any,
  spawnDialog: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [...scalableActions(addTab, spawnDialog, router, context, kubeConfig)];
}
