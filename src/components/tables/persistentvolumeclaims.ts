import { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedCell, statusCell } from "./cells";
import { statusTone } from "@/components/ui/status";

export const columns: ColumnDef<V1PersistentVolumeClaim>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Storage Class",
    accessorKey: "spec.storageClassName",
    meta: { class: () => mutedCell },
  },
  {
    header: "Size",
    accessorKey: "status.capacity.storage",
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  {
    header: "Status",
    accessorKey: "status.phase",
    enableGlobalFilter: false,
    cell: ({ row }) => {
      const phase = row.original.status?.phase || "";
      const tone = statusTone(phase);
      return statusCell(phase, tone === "info" || tone === "primary" ? "none" : tone);
    },
  },
  ageColumn<V1PersistentVolumeClaim>((row) => row.metadata?.creationTimestamp),
];
