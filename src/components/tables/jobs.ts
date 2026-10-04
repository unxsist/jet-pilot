import { V1Job } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
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
    enableGlobalFilter: false,
  },
  {
    header: "Duration",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.status?.startTime || new Date(),
        row.status?.completionTime || new Date()
      ),
    enableGlobalFilter: false,
  },
  ageColumn<V1Job>((row) => row.metadata?.creationTimestamp),
];
