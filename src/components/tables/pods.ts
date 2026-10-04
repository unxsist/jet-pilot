import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import {
  getPodReadiness,
  getPodReadinessTone,
  getPodRestarts,
  getPodStatus,
  getPodStatusTone,
  getRestartsTone,
  toneClass,
} from "./status";
import PodUsageChart from "../ui/PodUsageChart.vue";
import { monoCell, mutedCell, statusCell } from "./cells";

type PodRow = V1Pod & { metrics: PodMetric[] };

export const columns: ColumnDef<PodRow>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Ready",
    accessorFn: (row) => {
      const { ready, total } = getPodReadiness(row);
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
    meta: {
      class: (row) => `tabular-nums ${toneClass(getPodReadinessTone(row))}`,
    },
  },
  {
    header: "Restarts",
    accessorFn: (row) => getPodRestarts(row),
    enableGlobalFilter: false,
    meta: {
      numeric: true,
      class: (row) => toneClass(getRestartsTone(getPodRestarts(row))),
    },
  },
  {
    header: "Status",
    accessorFn: (row) => getPodStatus(row),
    cell: ({ row }) => {
      const status = getPodStatus(row.original);
      return statusCell(status, getPodStatusTone(status));
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
    meta: { class: () => monoCell },
  },
  {
    header: "Node",
    accessorKey: "spec.nodeName",
    meta: { class: () => mutedCell },
  },
  ageColumn<PodRow>((row) => row.metadata?.creationTimestamp),
];
