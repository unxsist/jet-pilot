import { V1Node } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { getNodeStatus, getNodeStatusTone } from "./status";
import { mutedCell, statusCell } from "./cells";

export const columns: ColumnDef<V1Node>[] = [
  {
    accessorKey: "metadata.name",
    header: "Name",
  },
  {
    header: "Taints",
    accessorFn: (row) => {
      const taints = row.spec?.taints || [];
      return taints.length;
    },
    enableGlobalFilter: false,
    meta: { numeric: true },
  },
  {
    header: "Roles",
    accessorFn: (row) => {
      const roles = Object.keys(row.metadata?.labels || {}).filter((key) =>
        key.startsWith("node-role.kubernetes.io/")
      );
      return roles.map((role) => role.split("/")[1]).join(", ");
    },
  },
  {
    header: "Version",
    accessorFn: (row) => row.status?.nodeInfo?.kubeletVersion,
    meta: { class: () => `${mutedCell} font-mono text-xs` },
  },
  {
    header: "Status",
    accessorFn: (row) => getNodeStatus(row),
    cell: ({ row }) => {
      const status = getNodeStatus(row.original);
      return statusCell(status, getNodeStatusTone(status));
    },
  },
  ageColumn<V1Node>((row) => row.metadata?.creationTimestamp),
];
