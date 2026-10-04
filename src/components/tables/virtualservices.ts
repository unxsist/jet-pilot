import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

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
  ageColumn<VirtualService>((row) => row.metadata?.creationTimestamp),
];
