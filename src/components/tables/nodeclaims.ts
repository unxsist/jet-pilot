import { h } from "vue";
import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { monoColumn, mutedColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import {
  capacityType,
  instanceType,
  nodeClaimState,
  zoneOf,
} from "@/lib/operators/karpenter";

/* Karpenter NodeClaims: state, instance type (spot / on-demand), zone, node. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => nodeClaimState(row)),
  {
    id: "Instance",
    header: "Instance",
    accessorFn: (row) => [instanceType(row), capacityType(row)].filter(Boolean).join(" "),
    cell: ({ row }) => {
      const capacity = capacityType(row.original);
      return h("span", { class: "inline-flex items-baseline gap-1.5" }, [
        h("span", { class: "font-mono text-xs" }, instanceType(row.original) ?? ""),
        capacity
          ? h(
              "span",
              { class: capacity === "Spot" ? "text-xs text-info" : "text-xs text-muted-foreground" },
              capacity
            )
          : null,
      ]);
    },
  },
  mutedColumn("Zone", (row) => zoneOf(row)),
  monoColumn("Node", (row) => row.status?.nodeName),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
