import { V1CronJob, V1Job } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<V1CronJob>[] = [
  ...multiContextColumns,
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
  {
    header: "Last Schedule",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.status?.lastScheduleTime || new Date(),
        new Date()
      ),
    enableGlobalFilter: false,
  },
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
    sortingFn: (a, b) => {
      return (
        new Date(a.original.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.original.metadata?.creationTimestamp || 0).getTime()
      );
    },
    enableGlobalFilter: false,
  },
];
