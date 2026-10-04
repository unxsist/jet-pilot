import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { statusTone } from "@/components/ui/status";
import { monoCell, mutedCell, statusCell } from "./cells";
import { parseJSON } from "date-fns";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "name",
    header: "Name",
  },
  {
    accessorKey: "namespace",
    header: "Namespace",
    meta: { class: () => mutedCell },
  },
  {
    accessorKey: "chart",
    header: "Chart",
    meta: { class: () => monoCell },
  },
  {
    accessorKey: "revision",
    header: "Revision",
    meta: { numeric: true },
  },
  {
    accessorKey: "app_version",
    header: "App Version",
    meta: { class: () => monoCell },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status: string = row.original.status || "";
      // uninstalled releases are history, not failures.
      const tone = status === "uninstalled" ? "muted" : statusTone(status);
      return statusCell(status, tone === "info" || tone === "primary" ? "none" : tone);
    },
    enableGlobalFilter: false,
  },
  ageColumn<any>(
    (row) => (row.updated ? parseJSON(row.updated) : undefined),
    "Updated"
  ),
];
