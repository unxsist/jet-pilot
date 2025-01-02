import { formatDateTimeDifference } from "@/lib/utils";
import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { ColumnDef } from "@tanstack/vue-table";

export const columns: ColumnDef<VirtualService>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Gateways",
    accessorFn: (row) => {
      return `${row.spec?.gateways?.join("; ")}`;
    },
  },
  {
    header: "Hosts",
    accessorFn: (row) => {
      return `${row.spec?.hosts?.join("; ")}`;
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
