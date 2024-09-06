import { formatDateTimeDifference } from "@/lib/utils";
import { V1Node } from "@kubernetes/client-node";
import { ColumnDef } from "@tanstack/vue-table";

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
  },
  {
    header: "Roles",
    accessorFn: (row) => {
      console.log(row.metadata?.labels);
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
    accessorFn: (row) => {
      return (
        row.status?.conditions?.[row.status?.conditions.length - 1]?.type ||
        "Unknown"
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
  },
];
