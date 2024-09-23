import { V1Job } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

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
  },
  {
    header: "Duration",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.status?.startTime || new Date(),
        row.status?.completionTime || new Date()
      ),
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
  },
];
