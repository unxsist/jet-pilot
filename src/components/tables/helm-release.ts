import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
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
            return "text-green-500";
          case "uninstalled":
            return "text-red-500";
          case "superseded":
            return "text-yellow-500";
          case "failed":
            return "text-red-500";
          default:
            return "";
        }
      },
    },
  },
  {
    header: "Updated",
    accessorFn: (row) =>
      formatDateTimeDifference(
        parseJSON(row.updated) || new Date(),
        new Date()
      ),
  },
];
