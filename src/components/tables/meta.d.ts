import "@tanstack/table-core";
import type { RowData } from "@tanstack/table-core";

declare module "@tanstack/table-core" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Column shown only when multiple clusters are active. */
    showOnMultipleClusters?: boolean;
    /** Column shown when multiple namespaces are active (within one or more clusters). */
    showOnMultipleNamespaces?: boolean;
    /** Cell class function used by VirtualDataTable. */
    class?: (row: TData) => string;
    /** Right-aligned tabular numerals for cell and header (counts, ages). */
    numeric?: boolean;
    /** Cell tooltip; defaults to the cell value (useful for truncated cells). */
    title?: (row: TData) => string | undefined;
    /** Header tooltip (e.g. a printer column description). */
    headerTitle?: string;
    /** Hidden until the user shows it (e.g. priority > 0 printer columns). */
    defaultHidden?: boolean;
  }
}
