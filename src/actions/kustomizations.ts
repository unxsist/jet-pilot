import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { fluxActions } from "@/lib/gitops/rowActions";

/* Flux Kustomizations: reconcile (with its source), suspend / resume. */
export function actions<T>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return fluxActions<T>();
}
