import { ColumnDef } from "@tanstack/vue-table";
import { contextCell, mutedCell } from "./cells";

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
    cell: ({ getValue }) => contextCell(String(getValue() ?? "")),
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
