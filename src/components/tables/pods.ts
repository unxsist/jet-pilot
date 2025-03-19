import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
import PodUsageChart from "../ui/PodUsageChart.vue";

export const columns: ColumnDef<V1Pod & { metrics: PodMetric[] }>[] = [
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
    enableGlobalFilter: false,
    meta: {
      class: (row: V1Pod) => {
        return row.status?.containerStatuses?.filter((c) => c.ready).length ===
          row.status?.containerStatuses?.length
          ? ""
          : "text-red-500";
      },
    },
  },
  {
    header: "Restarts",
    accessorFn: (row) =>
      `${row.status?.containerStatuses?.reduce((acc, curr) => {
        return acc + curr.restartCount;
      }, 0)}`,
    enableGlobalFilter: false,
  },
  {
    header: "Status",
    accessorFn: (row) => {
      if (row.metadata?.deletionTimestamp) {
        return "Terminating";
      }

      return (
        row.status?.containerStatuses?.reduce((acc, curr) => {
          return acc || curr.state.waiting || curr.state.terminated;
        }, null)?.reason ||
        row.status?.phase ||
        "Unknown"
      );
    },
    enableGlobalFilter: false,
    meta: {
      class: (row: V1Pod) => {
        if (row.metadata?.deletionTimestamp) {
          return "text-red-500";
        }

        const status =
          row.status?.containerStatuses?.reduce((acc, curr) => {
            return acc || curr.state.waiting || curr.state.terminated;
          }, null)?.reason ||
          row.status?.phase ||
          "Unknown";

        switch (status) {
          case "Running":
            return "text-green-500";
          case "CrashLoopBackOff":
            return "text-red-500";
          case "Error":
            return "text-red-500";
          default:
            return;
        }
      },
    },
  },
  {
    header: "Usage",
    size: 100,
    cell: ({ row }) => {
      return h(PodUsageChart, { pod: row.original });
    },
    enableGlobalFilter: false,
  },
  {
    header: "IP",
    accessorFn: (row) => row.status?.podIP || "",
    enableGlobalFilter: false,
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
    sortingFn: (a, b) => {
      return (
        new Date(a.original.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.original.metadata?.creationTimestamp || 0).getTime()
      );
    },
    enableGlobalFilter: false,
  },
];
