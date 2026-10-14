import { h } from "vue";
import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { countColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import {
  limitFillClass,
  nodePoolNodes,
  nodePoolState,
  nodePoolUsage,
  type Usage,
} from "@/lib/operators/karpenter";

/** "48 / 1000" with a slim bar against the pool's limit. */
const usageCell = (usage: Usage) =>
  h("span", { class: "inline-flex items-center gap-2.5" }, [
    usage.percent !== undefined
      ? h("span", { class: "relative h-1 w-12 overflow-hidden rounded-full bg-muted" }, [
          h("span", {
            class: ["absolute inset-y-0 left-0 rounded-full", limitFillClass(usage.percent)],
            style: { width: `${Math.max(usage.percent, 2)}%` },
          }),
        ])
      : null,
    h("span", { class: "tabular-nums text-muted-foreground" }, usage.short),
  ]);

const usageColumn = (resource: Usage["resource"], header: string): ColumnDef<any> => {
  const usage = (row: any) => nodePoolUsage(row).find((u) => u.resource === resource)!;
  return {
    id: header,
    header,
    accessorFn: (row) => usage(row).percent ?? usage(row).used,
    cell: ({ row }) => usageCell(usage(row.original)),
    enableGlobalFilter: false,
    meta: { title: (row) => usage(row).text },
  };
};

/* Karpenter NodePools: ready, nodes, CPU and memory against the limits. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => nodePoolState(row)),
  countColumn("Nodes", (row) => nodePoolNodes(row)),
  usageColumn("cpu", "CPU"),
  usageColumn("memory", "Memory"),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
