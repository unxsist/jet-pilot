import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { argoActions } from "@/lib/gitops/rowActions";

/* Argo CD Applications: sync (prune as a choice), refresh and hard refresh. */
export function actions<T>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return argoActions<T>(spawnDialog);
}
