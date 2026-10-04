import { V1Secret } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

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
  ageColumn<V1Secret>((row) => row.metadata?.creationTimestamp),
];
