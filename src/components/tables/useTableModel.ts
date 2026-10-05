/*
 * Data pipeline of VirtualDataTable, outside the component so it can be
 * benchmarked / tested headless:
 *
 *   props.data -> reconcile (reuse unchanged rows) -> TanStack core + sort
 *   (stable Row objects) -> search filter (precomputed strings)
 *
 * Filtering happens after sorting and outside TanStack: a keystroke never
 * re-sorts nor rebuilds rows, a refresh only rebuilds the rows that changed.
 */
import { computed, type Ref } from "vue";
import {
  useVueTable,
  type ColumnDef,
  type Row,
  type SortingState,
  type TableOptions,
  type VisibilityState,
  type ColumnOrderState,
  type RowSelectionState,
} from "@tanstack/vue-table";
import { getRowIdentity } from "./identity";
import {
  createRowReconciler,
  createSearchIndex,
  getStableCoreRowModel,
  getStableSortedRowModel,
  naturalSortingFn,
  searchableColumns,
} from "./rowModel";

export interface TableModelOptions<TData> {
  data: () => TData[];
  /** Complete column list (incl. select / actions columns); keep it stable. */
  columns: () => ColumnDef<TData, any>[];
  query: () => string;
  sorting: Ref<SortingState>;
  onSortingChange?: (sorting: SortingState) => void;
  initialVisibility?: VisibilityState;
  initialColumnOrder?: ColumnOrderState;
  extraOptions?: Partial<TableOptions<TData>>;
}

export function useTableModel<TData>(options: TableModelOptions<TData>) {
  const reconcile = createRowReconciler<TData>(getRowIdentity);
  const stableData = computed(() => reconcile(options.data()));
  const columns = computed(() => options.columns());

  const table = useVueTable<TData>({
    get data() {
      return stableData.value;
    },
    get columns() {
      return columns.value;
    },
    /*
     * Stable row ids (context + uid) so selection, row keys, the keyboard
     * cursor and the context menu subject survive refreshes that reorder,
     * add or remove rows.
     */
    getRowId: (row, index) => getRowIdentity(row) ?? String(index),
    initialState: {
      ...(options.initialVisibility
        ? { columnVisibility: options.initialVisibility }
        : {}),
      ...(options.initialColumnOrder
        ? { columnOrder: options.initialColumnOrder }
        : {}),
    },
    getCoreRowModel: getStableCoreRowModel<TData>(),
    getSortedRowModel: getStableSortedRowModel<TData>(),
    autoResetAll: false,
    manualSorting: false,
    enableRowSelection: true,
    state: {
      get sorting() {
        return options.sorting.value;
      },
    },
    onSortingChange: (updater) => {
      options.sorting.value =
        typeof updater === "function"
          ? updater(options.sorting.value)
          : updater;
      options.onSortingChange?.(options.sorting.value);
    },
    defaultColumn: {
      minSize: 0,
      size: Number.MAX_SAFE_INTEGER,
      maxSize: Number.MAX_SAFE_INTEGER,
      sortingFn: naturalSortingFn,
    },
    ...(options.extraOptions || {}),
  });

  /* All rows, sorted (stable: ties keep the data order). */
  const sortedRows = computed<Row<TData>[]>(() => table.getRowModel().rows);

  const searchColumns = computed(() => searchableColumns(table));
  const searchIndex = createSearchIndex<TData>();

  /* Sorted rows passing the search query. */
  const filteredRows = computed<Row<TData>[]>(() =>
    searchIndex.filter(sortedRows.value, options.query(), searchColumns.value)
  );

  /* Selected rows that pass the current filter (mass actions apply to these). */
  const selectedRows = computed<Row<TData>[]>(() => {
    const selection: RowSelectionState = table.getState().rowSelection;
    for (const _ in selection) {
      return filteredRows.value.filter((row) => selection[row.id]);
    }
    return [];
  });

  return {
    table,
    stableData,
    sortedRows,
    filteredRows,
    selectedRows,
  };
}
