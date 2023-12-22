import { formatDateTimeDifference } from "@/lib/utils";
import { V1Ingress } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";

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
  {
    header: "Age",
    accessorFn: (row) =>
      formatDateTimeDifference(
        row.metadata?.creationTimestamp || new Date(),
        new Date()
      ),
  },
];
