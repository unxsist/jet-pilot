import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { fluxActions } from "@/lib/gitops/rowActions";

/*
 * Flux HelmReleases (helm.toolkit.fluxcd.io): reconcile (with its chart
 * source), suspend / resume. The app's Helm view has its own actions
 * (helm-release.ts).
 */
export function actions<T>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  return fluxActions<T>();
}
