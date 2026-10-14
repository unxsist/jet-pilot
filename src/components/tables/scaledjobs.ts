import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { scaledObjectState, triggersInWords } from "@/lib/operators/keda";

/* KEDA ScaledJobs: state, the most jobs at once, triggers in words. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => scaledObjectState(row)),
  {
    id: "Max jobs",
    header: "Max jobs",
    accessorFn: (row) => Number(row.spec?.maxReplicaCount ?? 100),
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  textColumn("Triggers", (row) => triggersInWords(row, 1)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
