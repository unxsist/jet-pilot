import { RowAction } from "@/components/tables/types";
import { isPaused } from "@/lib/operators/keda";
import { setAutoscalingPaused } from "@/lib/operators/actions";

/* KEDA ScaledObjects (and ScaledJobs): pause / resume autoscaling. */
export function actions<T>(addTab: any, spawnDialog: any): RowAction<T>[] {
  return [
    {
      label: "Pause autoscaling",
      kind: "pause",
      isAvailable: (row: T) => !isPaused(row),
      handler: (row: T) => setAutoscalingPaused(row as any, true, spawnDialog),
    },
    {
      label: "Resume autoscaling",
      kind: "resume",
      isAvailable: (row: T) => isPaused(row),
      handler: (row: T) => setAutoscalingPaused(row as any, false, spawnDialog),
    },
  ];
}
