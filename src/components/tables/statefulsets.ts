import { formatDateTimeDifference } from "@/lib/utils";
import { V1ReplicaSet } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<V1ReplicaSet>[] = [
  ...multiContextColumns,
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Pods",
    accessorFn: (row) => {
      const ready = row.status?.readyReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
  },
  {
    header: "Replicas",
    accessorKey: "spec.replicas",
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
