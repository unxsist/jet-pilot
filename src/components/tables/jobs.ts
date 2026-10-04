import { V1Job } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { formatDateTimeDifference } from "@/lib/utils";

const duration = (row: V1Job) => {
  const start = row.status?.startTime;
  if (!start) return 0;
  const end = row.status?.completionTime
    ? new Date(row.status.completionTime)
    : new Date();
  return end.getTime() - new Date(start).getTime();
};

export const columns: ColumnDef<V1Job>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Completions",
    accessorFn: (row) => {
      return `${row.status?.succeeded ?? 0}/${row.spec?.completions}`;
    },
    enableGlobalFilter: false,
    meta: { class: () => "tabular-nums" },
  },
  {
    header: "Duration",
    // Duration in ms (running jobs: until now), formatted at render time.
    accessorFn: (row) => duration(row),
    cell: ({ row }) => {
      const start = row.original.status?.startTime;
      return start
        ? formatDateTimeDifference(
            new Date(start),
            row.original.status?.completionTime
              ? new Date(row.original.status.completionTime)
              : new Date()
          )
        : "-";
    },
    enableGlobalFilter: false,
    meta: { numeric: true, class: () => "text-muted-foreground" },
  },
  ageColumn<V1Job>((row) => row.metadata?.creationTimestamp),
];
