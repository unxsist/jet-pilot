import { formatDateTimeDifference } from "@/lib/utils";
import { V1Ingress } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "./multicontext";

export const columns: ColumnDef<V1Ingress>[] = [
  ...multiContextColumns,
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Class",
    accessorKey: "spec.ingressClassName",
  },
  {
    header: "Hosts",
    accessorFn: (row) => {
      return `${row.spec?.rules?.map((rule) => rule.host).join("; ")}`;
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
