import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
import { RouterLink } from "vue-router";
import { formatResourceKind } from "@/lib/utils";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<any>[] = [
  ...multiContextColumns,
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
    enableGlobalFilter: false,
  },
  {
    accessorKey: "source.component",
    header: "Source",
  },
  {
    accessorKey: "count",
    header: "Count",
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
    enableGlobalFilter: false,
  },
];
