import { V1ConfigMap } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

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
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<V1ConfigMap>((row) => row.metadata?.creationTimestamp),
];
