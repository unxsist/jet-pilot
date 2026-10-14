/*
 * Building blocks of the operator tables (src/components/tables/<plural>.ts
 * for cert-manager, Gateway API, Karpenter, KEDA, External Secrets and the
 * Prometheus Operator): a state in words with a dot, quiet secondary text,
 * monospace only for values people copy.
 */
import { h } from "vue";
import type { ColumnDef } from "@tanstack/vue-table";
import { StatusDot, statusTextClass, type StatusTone } from "@/components/ui/status";
import { mutedCell, monoCell } from "@/components/tables/cells";
import type { OperatorState } from "./format";

export const nameColumn: ColumnDef<any> = { accessorKey: "metadata.name", header: "Name" };

/* Problems first when sorted ascending. */
const SEVERITY: Record<StatusTone, number> = {
  destructive: 0,
  warning: 1,
  info: 2,
  primary: 2,
  muted: 3,
  success: 4,
};

/** Healthy states stay quiet (neutral text); problems get colour. */
export const stateCell = (state: OperatorState) =>
  h("span", { class: "inline-flex max-w-full items-center gap-2" }, [
    h(StatusDot, { tone: state.tone, pulse: !!state.busy }),
    h(
      "span",
      {
        class: [
          "truncate",
          state.tone === "success" || state.tone === "info"
            ? "text-foreground"
            : statusTextClass[state.tone],
        ],
      },
      state.label
    ),
  ]);

export function stateColumn<T = any>(
  derive: (row: T) => OperatorState,
  header = "Status"
): ColumnDef<T> {
  return {
    id: header,
    header,
    accessorFn: (row) => derive(row).label,
    cell: ({ row }) => stateCell(derive(row.original)),
    sortingFn: (a, b) => {
      const x = derive(a.original);
      const y = derive(b.original);
      return SEVERITY[x.tone] - SEVERITY[y.tone] || x.label.localeCompare(y.label);
    },
    meta: {
      title: (row) => {
        const state = derive(row);
        return state.message || state.reason || state.label;
      },
    },
  };
}

/** Secondary text (issuers, stores, classes). */
export function mutedColumn<T = any>(
  header: string,
  value: (row: T) => string | undefined
): ColumnDef<T> {
  return {
    id: header,
    header,
    accessorFn: (row) => value(row) ?? "",
    meta: { class: () => mutedCell },
  };
}

/** Values people copy (addresses, instance types). */
export function monoColumn<T = any>(
  header: string,
  value: (row: T) => string | undefined
): ColumnDef<T> {
  return {
    id: header,
    header,
    accessorFn: (row) => value(row) ?? "",
    meta: { class: () => monoCell },
  };
}

/** Plain text in the foreground (hostnames, triggers). */
export function textColumn<T = any>(
  header: string,
  value: (row: T) => string | undefined
): ColumnDef<T> {
  return { id: header, header, accessorFn: (row) => value(row) ?? "" };
}

/** A count, right-aligned. */
export function countColumn<T = any>(
  header: string,
  value: (row: T) => number | undefined
): ColumnDef<T> {
  return {
    id: header,
    header,
    accessorFn: (row) => value(row) ?? "",
    enableGlobalFilter: false,
    meta: { numeric: true },
  };
}
