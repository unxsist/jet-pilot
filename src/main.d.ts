import "@tanstack/vue-table";

declare module "@tanstack/table-core" {
  interface ColumnMeta<TData extends RowData, TValue> {
    class: string | undefined;
  }
}
