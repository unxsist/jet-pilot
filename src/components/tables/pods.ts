import { V1Pod } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";

export const columns: ColumnDef<V1Pod>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
    meta: {
      class: (row: V1Pod) => {
        return row.status?.phase === "Pending" ? "text-orange-500" : "";
      },
    },
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
    accessorFn: (row) => {
      if (row.metadata?.deletionTimestamp) {
        return "Terminating";
      }

      return row.status?.phase;
    },
  },
  {
    header: "CPU",
  },
  {
    header: "IP",
    accessorFn: (row) => row.status?.podIP || "",
  },
  {
    header: "Node",
    accessorKey: "spec.nodeName",
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
