import { formatDateTimeDifference } from "@/lib/utils";
import { V1Deployment } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";

export const columns: ColumnDef<V1Deployment>[] = [
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
  },
  {
    header: "Up-to-date",
    accessorFn: (row) => {
      const ready = row.status?.updatedReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
  },
  {
    header: "Available",
    accessorKey: "status.availableReplicas",
  },
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
  },
];
