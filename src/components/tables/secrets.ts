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
    meta: { class: () => "font-mono text-xs text-muted-foreground" },
  },
  {
    header: "Data",
    accessorFn: (row) => {
      return `${Object.keys(row.data || {}).length}`;
    },
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<V1Secret>((row) => row.metadata?.creationTimestamp),
];
