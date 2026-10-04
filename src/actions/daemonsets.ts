import { V1DaemonSet } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { logsAction, restartAction, rolloutHistoryAction } from "./workload";

export function actions<
  T extends V1DaemonSet & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  spawnDialog: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _setSidePanelComponent: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _router: Router
): RowAction<T>[] {
  return [
    logsAction<any>(addTab),
    rolloutHistoryAction<any>(addTab),
    restartAction<any>(spawnDialog),
  ];
}
