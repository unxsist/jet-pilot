import { V1Pod } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { RowAction } from "@/components/tables/types";

export const columns: ColumnDef<V1Pod>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Ready",
    accessorFn: (row) =>
      `${row.status?.containerStatuses?.reduce((acc, curr) => {
        return curr.ready ? acc + 1 : acc;
      }, 0)} / ${row.status?.containerStatuses?.length}`,
  },
  {
    header: "Restarts",
    accessorFn: (row) =>
      `${row.status?.containerStatuses?.reduce((acc, curr) => {
        return acc + curr.restartCount;
      }, 0)}`,
  },
  {
    header: "Status",
    accessorFn: (row) => row.status?.phase,
  },
  {
    header: "CPU",
  },
  {
    header: "IP",
    accessorKey: "status.podIP",
  },
  {
    header: "Node",
    accessorKey: "spec.nodeName",
  },
];

export const rowActions: RowAction<V1Pod>[] = [
  {
    label: "Describe",
    handler: (row) => {
      console.log("Describe", row);
    },
  },
  {
    label: "Logs",
    handler: (row) => {
      console.log("Logs", row);
    },
  },
];
