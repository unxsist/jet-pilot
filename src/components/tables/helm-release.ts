import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { toneClass } from "./status";
import { parseJSON } from "date-fns";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "name",
    header: "Name",
  },
  {
    accessorKey: "namespace",
    header: "Namespace",
  },
  {
    accessorKey: "chart",
    header: "Chart",
  },
  {
    accessorKey: "revision",
    header: "Revision",
  },
  {
    accessorKey: "app_version",
    header: "App Version",
  },
  {
    accessorKey: "status",
    header: "Status",
    meta: {
      class: (row: any) => {
        switch (row.status) {
          case "deployed":
            return toneClass("success");
          case "failed":
            return toneClass("destructive");
          case "uninstalled":
          case "superseded":
            return toneClass("muted");
          case "pending-install":
          case "pending-upgrade":
          case "pending-rollback":
          case "uninstalling":
            return toneClass("warning");
          default:
            return "";
        }
      },
    },
    enableGlobalFilter: false,
  },
  ageColumn<any>(
    (row) => (row.updated ? parseJSON(row.updated) : undefined),
    "Updated"
  ),
];
