import { CoreV1Event } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { getEventLastSeen, getEventTypeTone } from "./status";
import { mutedCell, statusCell } from "./cells";
import { RouterLink } from "vue-router";
import { formatResourceKind } from "@/lib/utils";

export const columns: ColumnDef<CoreV1Event>[] = [
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) =>
      statusCell(
        row.original.type || "",
        getEventTypeTone(row.original.type) === "warning" ? "warning" : "muted"
      ),
  },
  {
    accessorKey: "message",
    header: "Message",
    size: 500,
  },
  {
    accessorKey: "metadata.namespace",
    header: "Namespace",
    meta: { class: () => mutedCell },
  },
  {
    header: "Object",
    cell: ({ row }) => {
      return h(
        RouterLink,
        {
          class:
            "text-link underline-offset-2 hover:underline focus-visible:underline",
          onClick: (event: MouseEvent) => event.stopPropagation(),
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
    meta: { class: () => mutedCell },
  },
  {
    accessorKey: "count",
    header: "Count",
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<CoreV1Event>((row) => row.metadata?.creationTimestamp),
  ageColumn<CoreV1Event>((row) => getEventLastSeen(row), "Last seen"),
];
