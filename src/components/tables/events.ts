import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "type",
    header: "Type",
  },
  {
    accessorKey: "message",
    header: "Message",
    size: 500,
  },
  {
    accessorKey: "metadata.namespace",
    header: "Namespace",
  },
  {
    header: "Object",
    accessorFn: (row) => {
      const obj = row.involvedObject;
      return `${obj.kind}/${obj.name}`;
    },
  },
  {
    accessorKey: "source.component",
    header: "Source",
  },
  {
    accessorKey: "count",
    header: "Count",
  },
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
  },
  {
    header: "Last seen",
    accessorFn: (row) =>
      formatDateTimeDifference(row.lastTimestamp || new Date(), new Date()),
  },
];
