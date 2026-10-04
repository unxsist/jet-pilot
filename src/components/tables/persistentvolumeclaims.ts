import { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

export const columns: ColumnDef<V1PersistentVolumeClaim>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Storage Class",
    accessorKey: "spec.storageClassName",
  },
  {
    header: "Size",
    accessorKey: "status.capacity.storage",
    enableGlobalFilter: false,
  },
  {
    header: "Status",
    accessorKey: "status.phase",
    enableGlobalFilter: false,
  },
  ageColumn<V1PersistentVolumeClaim>((row) => row.metadata?.creationTimestamp),
];
