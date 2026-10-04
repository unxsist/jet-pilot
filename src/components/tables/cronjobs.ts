import { V1CronJob } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

export const columns: ColumnDef<V1CronJob>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Schedule",
    accessorKey: "spec.schedule",
  },
  {
    header: "Suspend",
    accessorKey: "spec.suspend",
    enableGlobalFilter: false,
  },
  {
    header: "Active",
    accessorFn: (row) => {
      return `${row.status?.active?.length ?? 0}`;
    },
    enableGlobalFilter: false,
  },
  ageColumn<V1CronJob>((row) => row.status?.lastScheduleTime, "Last Schedule"),
  ageColumn<V1CronJob>((row) => row.metadata?.creationTimestamp),
];
