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
      class: (row) => toneClass(getPodReadinessTone(row)),
    },
  },
  {
    header: "Restarts",
    accessorFn: (row) => getPodRestarts(row),
    enableGlobalFilter: false,
    meta: {
      class: (row) => toneClass(getRestartsTone(getPodRestarts(row))),
    },
  },
  {
    header: "Status",
    accessorFn: (row) => getPodStatus(row),
    meta: {
      class: (row) => toneClass(getPodStatusTone(getPodStatus(row))),
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
  ageColumn<PodRow>((row) => row.metadata?.creationTimestamp),
];
