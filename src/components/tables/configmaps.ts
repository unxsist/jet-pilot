import { V1ConfigMap } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

export const columns: ColumnDef<V1ConfigMap>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Data",
    accessorFn: (row) => {
      return `${Object.keys(row.data || {}).length}`;
    },
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
