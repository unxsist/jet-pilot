import { V1Deployment } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import {
  getDeploymentReadiness,
  getReplicaTone,
  toneClass,
} from "./status";

export const columns: ColumnDef<V1Deployment>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Ready",
    accessorFn: (row) => {
      const { ready, total } = getDeploymentReadiness(row);
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
    meta: {
      class: (row) => {
        const { ready, total } = getDeploymentReadiness(row);
        return `tabular-nums ${toneClass(getReplicaTone(ready, total))}`;
      },
    },
  },
  {
    header: "Up-to-date",
    accessorFn: (row) => {
      const ready = row.status?.updatedReplicas || 0;
      const total = row.status?.replicas || 0;
      return `${ready}/${total}`;
    },
    enableGlobalFilter: false,
    meta: { class: () => "tabular-nums text-muted-foreground" },
  },
  {
    header: "Available",
    accessorFn: (row) => row.status?.availableReplicas || "",
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  ageColumn<V1Deployment>((row) => row.metadata?.creationTimestamp),
];
