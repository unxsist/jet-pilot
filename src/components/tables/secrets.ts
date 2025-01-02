import { V1Secret } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

export const columns: ColumnDef<V1Secret>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Type",
    accessorKey: "type",
  },
  {
    header: "Data",
    accessorFn: (row) => {
      return `${Object.keys(row.data || {}).length}`;
    },
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
