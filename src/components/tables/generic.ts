import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
