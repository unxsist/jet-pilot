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
    meta: {
      class: "text-right",
    },
  },
  {
    header: "Up-to-date",
    accessorFn: (row) => {
      const ready = row.status?.updatedReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
    meta: {
      class: "text-right",
    },
  },
  {
    header: "Available",
    accessorKey: "status.availableReplicas",
    meta: {
      class: "text-right",
    },
  },
  {
    header: "Age",
    accessorFn: (row) => {
      const date = new Date(row.metadata?.creationTimestamp || "");
      return `${Math.floor(
        (Date.now() - date.getTime()) / 1000 / 60 / 60 / 24
      )}d`;
    },
  },
];
