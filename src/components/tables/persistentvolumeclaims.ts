import { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { formatDateTimeDifference } from "@/lib/utils";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<V1PersistentVolumeClaim>[] = [
  ...multiContextColumns,
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
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
    sortingFn: (a, b) => {
      return (
        new Date(a.original.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.original.metadata?.creationTimestamp || 0).getTime()
      );
    },
    enableGlobalFilter: false,
  },
];
