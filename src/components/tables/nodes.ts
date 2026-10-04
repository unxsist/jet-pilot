import { V1Node } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { getNodeStatus, getNodeStatusTone, toneClass } from "./status";

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
  },
  {
    header: "Status",
    accessorFn: (row) => getNodeStatus(row),
    meta: {
      class: (row) => toneClass(getNodeStatusTone(getNodeStatus(row))),
    },
  },
  ageColumn<V1Node>((row) => row.metadata?.creationTimestamp),
];
