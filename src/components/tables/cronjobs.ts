import { V1CronJob, V1Job } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

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
  },
  {
    header: "Active",
    accessorFn: (row) => {
      return `${row.status?.active?.length ?? 0}`;
    },
  },
  {
    header: "Last Schedule",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.status?.lastScheduleTime || new Date(),
        new Date()
      ),
  },
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
  },
];
