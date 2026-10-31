import { ColumnDef } from "@tanstack/vue-table";
import { contextCell, mutedCell } from "./cells";
import { resolveCluster } from "@/lib/clusters/meta";
import { runtimeSettings } from "@/lib/settings/runtime";

/**
 * Columns shown when multiple clusters / namespaces are in play.
 *
 * The VirtualDataTable toggles visibility of these columns based on the active
 * multi-context state (see `showOnMultipleClusters` / `showOnMultipleNamespaces`
 * in @/components/tables/meta.d.ts).
 */
export const multiContextColumns: ColumnDef<any>[] = [
  {
    id: "context",
    meta: {
      showOnMultipleClusters: true,
      // The cluster's name as the cell shows it (its alias, if it has one).
      text: (row) =>
        resolveCluster(runtimeSettings()?.clusters, row?.metadata?.context ?? "", row?.metadata?.kubeConfig)
          .displayName,
    },
    accessorKey: "metadata.context",
    header: "Context",
    cell: ({ getValue, row }) =>
      contextCell(String(getValue() ?? ""), (row.original as any)?.metadata?.kubeConfig),
  },
  {
    id: "namespace",
    meta: {
      showOnMultipleClusters: true,
      showOnMultipleNamespaces: true,
      class: () => mutedCell,
    },
    accessorKey: "metadata.namespace",
    header: "Namespace",
  },
];
