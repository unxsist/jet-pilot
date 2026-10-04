import { CoreV1Event } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { getEventLastSeen, getEventTypeTone, toneClass } from "./status";
import { RouterLink } from "vue-router";
import { formatResourceKind } from "@/lib/utils";

export const columns: ColumnDef<CoreV1Event>[] = [
  {
    accessorKey: "type",
    header: "Type",
    meta: {
      class: (row) => toneClass(getEventTypeTone(row.type)),
    },
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
    meta: {
      title: (row) =>
        `${row.involvedObject.kind}/${row.involvedObject.name}`,
    },
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
  ageColumn<CoreV1Event>((row) => row.metadata?.creationTimestamp),
  ageColumn<CoreV1Event>((row) => getEventLastSeen(row), "Last seen"),
];
