import { V1ReplicaSet } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

export const columns: ColumnDef<V1ReplicaSet>[] = [
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
    meta: { numeric: true },
  },
  ageColumn<V1ReplicaSet>((row) => row.metadata?.creationTimestamp),
];
