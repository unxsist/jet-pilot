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
    meta: { class: () => "font-mono text-xs" },
  },
  {
    header: "Suspend",
    accessorKey: "spec.suspend",
    enableGlobalFilter: false,
    meta: {
      class: (row) => (row.spec?.suspend ? "text-warning" : "text-muted-foreground"),
    },
  },
  {
    header: "Active",
    accessorFn: (row) => {
      return `${row.status?.active?.length ?? 0}`;
    },
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<V1CronJob>((row) => row.status?.lastScheduleTime, "Last Schedule"),
  ageColumn<V1CronJob>((row) => row.metadata?.creationTimestamp),
];
