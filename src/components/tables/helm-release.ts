import { h } from "vue";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { StatusDot } from "@/components/ui/status";
import { monoCell, mutedCell } from "./cells";
import { releaseStatus, type HelmReleaseRow } from "@/lib/helm";

/*
 * Releases read calm: name, chart and how it's doing. Healthy releases
 * stay quiet (a green dot), failed and pending ones say so in colour;
 * pending ones pulse while helm is still at work. Revision and app
 * version are a View › Columns away.
 */
const statusLabelClass = {
  success: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  info: "text-foreground",
  primary: "text-foreground",
} as const;

export const columns: ColumnDef<HelmReleaseRow>[] = [
  {
    accessorKey: "name",
    header: "Name",
    size: 260,
  },
  {
    id: "chart",
    header: "Chart",
    size: 280,
    accessorFn: (row) => `${row.chart} ${row.chartVersion}`,
    cell: ({ row }) =>
      h("span", { class: "inline-flex min-w-0 max-w-full items-baseline gap-1.5" }, [
        h("span", { class: "truncate" }, row.original.chart || "–"),
        row.original.chartVersion
          ? h("span", { class: "shrink-0 text-xs tabular-nums text-muted-foreground" }, row.original.chartVersion)
          : null,
      ]),
  },
  {
    accessorKey: "appVersion",
    header: "App version",
    meta: { class: () => monoCell, defaultHidden: true },
  },
  {
    accessorKey: "revision",
    header: "Revision",
    meta: { numeric: true, class: () => mutedCell, defaultHidden: true },
  },
  {
    accessorKey: "status",
    header: "Status",
    size: 150,
    // Sorted by the words people read.
    accessorFn: (row) => releaseStatus(row.status).label,
    cell: ({ row }) => {
      const status = releaseStatus(row.original.status);
      return h("span", { class: "inline-flex max-w-full items-center gap-2" }, [
        h(StatusDot, { tone: status.tone, pulse: status.busy }),
        h("span", { class: ["truncate", statusLabelClass[status.tone]] }, status.label),
      ]);
    },
    meta: { title: (row) => row.description || undefined },
  },
  ageColumn<HelmReleaseRow>((row) => row.updated ?? undefined, "Updated"),
];
