import { V1Ingress } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";

export const columns: ColumnDef<V1Ingress>[] = [
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
  ageColumn<V1Ingress>((row) => row.metadata?.creationTimestamp),
];
