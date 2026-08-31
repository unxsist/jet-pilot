import { ColumnDef } from "@tanstack/vue-table";

/**
 * Namespace column prepended to resource tables when "All namespaces" is
 * active (global namespace selection is empty), mirroring `kubectl get ... -A`
 * which lists the namespace each resource belongs to.
 */
export const namespaceColumn: ColumnDef<any> = {
  accessorKey: "metadata.namespace",
  header: "Namespace",
};
