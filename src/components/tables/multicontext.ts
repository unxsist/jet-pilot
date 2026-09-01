import { ColumnDef } from "@tanstack/vue-table";

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
    },
    accessorKey: "metadata.context",
    header: "Context",
  },
  {
    id: "namespace",
    meta: {
      showOnMultipleClusters: true,
      showOnMultipleNamespaces: true,
    },
    accessorKey: "metadata.namespace",
    header: "Namespace",
  },
];
