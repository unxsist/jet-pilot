import { formatDateTimeDifference } from "@/lib/utils";
import { V1Deployment } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<V1Deployment>[] = [
  ...multiContextColumns,
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Ready",
    accessorFn: (row) => {
      const ready = row.status?.readyReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
  },
  {
    header: "Up-to-date",
    accessorFn: (row) => {
      const ready = row.status?.updatedReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
  },
  {
    header: "Available",
    accessorFn: (row) => row.status?.availableReplicas || "",
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
