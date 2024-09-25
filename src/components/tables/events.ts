import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
import { RouterLink } from "vue-router";
import { formatResourceKind } from "@/lib/utils";

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
    cell: ({ row }) => {
      return h(
        RouterLink,
        {
          class: "text-primary",
          to: {
            path: `/${formatResourceKind(
              row.original.involvedObject.kind as string
            ).toLowerCase()}`,
            query: {
              resource: formatResourceKind(
                row.original.involvedObject.kind as string
              ),
              uid: row.original.involvedObject.uid,
            },
          },
        },
        () => [
          `${row.original.involvedObject.kind}/${row.original.involvedObject.name}`,
        ]
      );
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
    sortingFn: (a, b) => {
      return (
        new Date(a.original.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.original.metadata?.creationTimestamp || 0).getTime()
      );
    },
  },
  {
    header: "Last seen",
    accessorFn: (row) =>
      formatDateTimeDifference(row.lastTimestamp || new Date(), new Date()),
    sortingFn: (a, b) => {
      return (
        new Date(a.original.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.original.metadata?.creationTimestamp || 0).getTime()
      );
    },
  },
];
