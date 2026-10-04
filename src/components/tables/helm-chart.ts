import { ColumnDef } from "@tanstack/vue-table";
import { monoCell, mutedCell } from "./cells";

export const columns: ColumnDef<any>[] = [
  {
    header: "Name",
    size: 400,
    accessorFn: (row) => {
      return row.name.split("/").pop();
    },
  },
  {
    accessorKey: "description",
    header: "Description",
    size: 500,
    meta: { class: () => mutedCell },
  },
  {
    accessorKey: "version",
    header: "Version",
    meta: { class: () => monoCell },
  },
  {
    accessorKey: "app_version",
    header: "App Version",
    meta: { class: () => monoCell },
  },
  {
    header: "Repository",
    accessorFn: (row) => {
      return row.name.split("/").shift();
    },
    meta: { class: () => mutedCell },
  },
];
