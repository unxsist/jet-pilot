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
import { monoCell, mutedCell, statusCell } from "./cells";
import UsageSparkline from "./UsageSparkline.vue";
import {
  formatCpu,
  formatMemory,
  latestUsage,
  type MetricsSample,
} from "./metrics";

type PodRow = V1Pod & {
  metrics: PodMetric[];
  /** Usage history from the data layer (see ./metrics.ts). */
  metricsHistory?: MetricsSample[];
};

/*
 * CPU / Memory: sparkline of the usage history (or a single-sample meter)
 * with request / limit markers. Sorts by the latest usage; pods without
 * metrics sort last.
 */
const usageColumn = (resource: "cpu" | "memory"): ColumnDef<PodRow> => ({
  id: resource === "cpu" ? "CPU" : "Memory",
  header: resource === "cpu" ? "CPU" : "Memory",
  accessorFn: (row) => latestUsage(row, resource),
  sortUndefined: "last",
  cell: ({ row }) => h(UsageSparkline, { pod: row.original, resource }),
  enableGlobalFilter: false,
  meta: {
    numeric: true,
    title: (row) => {
      const value = latestUsage(row, resource);
      return value === undefined
        ? undefined
        : resource === "cpu"
          ? formatCpu(value)
          : formatMemory(value);
    },
  },
});

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
  usageColumn("cpu"),
  usageColumn("memory"),
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
