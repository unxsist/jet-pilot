import { V1Pod } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
  },
];
