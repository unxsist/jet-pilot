import { ColumnDef } from "@tanstack/vue-table";

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
  },
  {
    accessorKey: "version",
    header: "Version",
  },
  {
    accessorKey: "app_version",
    header: "App Version",
  },
  {
    header: "Repository",
    accessorFn: (row) => {
      return row.name.split("/").shift();
    },
  },
];
