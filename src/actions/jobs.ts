import { V1Job } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { logsAction } from "./workload";

export function actions<
  T extends V1Job & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spawnDialog: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _setSidePanelComponent: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _router: Router
): RowAction<T>[] {
  return [logsAction<any>(addTab)];
}
