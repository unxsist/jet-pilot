import { V1ReplicationController } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

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
    enableGlobalFilter: false,
  },
  {
    header: "Desired Replicas",
    accessorKey: "spec.replicas",
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<V1ReplicationController>((row) => row.metadata?.creationTimestamp),
];
