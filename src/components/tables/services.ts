import { formatDateTimeDifference } from "@/lib/utils";
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
