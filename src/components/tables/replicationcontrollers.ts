import { formatDateTimeDifference } from "@/lib/utils";
import { V1ReplicationController } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";

export const columns: ColumnDef<V1ReplicationController>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Replicas",
    accessorFn: (row) => {
      const ready = row.status?.readyReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
  },
  {
    header: "Desired Replicas",
    accessorKey: "spec.replicas",
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
  },
];
