import { V1Deployment, V1Service } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";

export const columns: ColumnDef<V1Service>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Type",
    accessorKey: "spec.type",
  },
  {
    header: "Cluster IP",
    accessorKey: "spec.clusterIP",
  },
  {
    header: "External IP",
    accessorFn: (row) => {
      return row.spec?.externalIPs?.join(", ") || "";
    },
  },
  {
    header: "Ports",
    accessorFn: (row) => {
      return (
        row.spec?.ports?.map((p) => `${p.name}:${p.port}`).join(", ") || ""
      );
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
