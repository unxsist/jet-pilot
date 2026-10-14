import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import {
  replicaRange,
  scaledObjectState,
  scaleTarget,
  triggersInWords,
} from "@/lib/operators/keda";

/* KEDA ScaledObjects: state, target, replica range, triggers in words. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => scaledObjectState(row)),
  mutedColumn("Target", (row) => {
    const target = scaleTarget(row);
    if (!target) return "";
    return target.kind === "Deployment" ? target.name : `${target.kind} ${target.name}`;
  }),
  {
    id: "Replicas",
    header: "Replicas",
    accessorFn: (row) => replicaRange(row).text,
    enableGlobalFilter: false,
    meta: { class: () => "tabular-nums text-muted-foreground" },
  },
  textColumn("Triggers", (row) => triggersInWords(row, 1)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
