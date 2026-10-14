import { h } from "vue";
import type { ColumnDef } from "@tanstack/vue-table";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { ageColumn } from "@/components/tables/age";
import { monoCell } from "@/components/tables/cells";
import { argoState, argoSource, fluxSource, fluxState, lastApplied, type DeliveryState } from "./model";

/*
 * Curated columns of the GitOps kinds' tables (src/components/tables/
 * kustomizations.ts, helmreleases.ts, applications.ts): the state in words
 * like on the GitOps page, the source in short form, the last apply.
 */

/* Problems get colour and words; healthy states stay quiet. */
const stateCell = (state: DeliveryState) => {
  const problem = state.category === "failing" || state.category === "attention";
  return h("span", { class: "inline-flex max-w-full items-center gap-2", title: state.message }, [
    h(StatusDot, { tone: state.tone, pulse: state.category === "progressing" }),
    h("span", { class: ["truncate", problem ? statusTextClass[state.tone] : "text-foreground"] }, state.label),
  ]);
};

const stateColumn = (derive: (row: any) => DeliveryState): ColumnDef<any> => ({
  id: "State",
  header: "State",
  accessorFn: (row) => derive(row).label,
  cell: ({ row }) => stateCell(derive(row.original)),
  sortingFn: (a, b) => derive(a.original).label.localeCompare(derive(b.original).label),
});

const nameColumn: ColumnDef<any> = { accessorKey: "metadata.name", header: "Name" };

export const kustomizationColumns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => fluxState(row)),
  {
    header: "Source",
    accessorFn: (row) => [fluxSource(row).repo, fluxSource(row).path].filter(Boolean).join(" · "),
    meta: { class: () => "text-muted-foreground" },
  },
  {
    header: "Revision",
    accessorFn: (row) => fluxSource(row).revision ?? "",
    meta: { class: () => monoCell },
  },
  ageColumn<any>((row) => lastApplied(row), "Last applied"),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];

export const helmReleaseColumns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => fluxState(row)),
  {
    header: "Chart",
    accessorFn: (row) => fluxSource(row).short,
    meta: { class: () => "text-muted-foreground" },
  },
  ageColumn<any>((row) => lastApplied(row), "Last applied"),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];

const healthTone = (health: string) =>
  health === "Healthy" ? "success" : health === "Degraded" ? "destructive" : health === "Progressing" ? "info" : health === "Missing" ? "warning" : "muted";

export const applicationColumns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => argoState(row)),
  {
    header: "Health",
    accessorFn: (row) => row.status?.health?.status ?? "Unknown",
    cell: ({ getValue }) => {
      const health = String(getValue());
      return h("span", { class: "inline-flex items-center gap-2 text-muted-foreground" }, [
        h(StatusDot, { tone: healthTone(health), size: "sm" }),
        health,
      ]);
    },
  },
  {
    header: "Source",
    accessorFn: (row) => {
      const source = argoSource(row);
      return source.chart ? source.short : [source.repo, source.path].filter(Boolean).join(" · ");
    },
    meta: { class: () => "text-muted-foreground" },
  },
  {
    header: "Revision",
    accessorFn: (row) => argoSource(row).revision ?? "",
    meta: { class: () => monoCell },
  },
  ageColumn<any>((row) => lastApplied(row), "Last sync"),
];
