import { V1Deployment, V1Service } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { monoCell, mutedCell } from "./cells";

export const columns: ColumnDef<V1Service>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Type",
    accessorKey: "spec.type",
    meta: { class: () => mutedCell },
  },
  {
    header: "Cluster IP",
    accessorKey: "spec.clusterIP",
    meta: { class: () => monoCell },
  },
  {
    header: "External IP",
    accessorFn: (row) => {
      return row.spec?.externalIPs?.join(", ") || "";
    },
    meta: { class: () => monoCell },
  },
  {
    header: "Ports",
    accessorFn: (row) => {
      return (
        row.spec?.ports?.map((p) => `${p.name}:${p.port}`).join(", ") || ""
      );
    },
    meta: { class: () => monoCell },
  },
  ageColumn<V1Service>((row) => row.metadata?.creationTimestamp),
];
