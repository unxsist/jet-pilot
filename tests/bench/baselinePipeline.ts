/*
 * The table data pipeline as it was before the table performance work
 * (origin/main VirtualDataTable): rows replaced wholesale on every refresh,
 * TanStack's per-column `includesString` global filter, the column list
 * rebuilt by a getter on every access. Kept for before/after benchmarks.
 */
import { shallowReactive, ref } from "vue";
import {
  useVueTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
} from "@tanstack/vue-table";
import { getRowIdentity } from "@/components/tables/identity";

export function createBaselinePipeline<T>(columns: ColumnDef<T, any>[]) {
  const props = shallowReactive({ data: [] as T[] });
  const sorting = ref<SortingState>([]);

  const table = useVueTable<T>({
    get data() {
      return props.data;
    },
    get columns() {
      return [
        { id: "select", size: 32, enableHiding: false, cell: () => null },
        ...columns,
      ] as ColumnDef<T, any>[];
    },
    getRowId: (row, index) => getRowIdentity(row) ?? String(index),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: "includesString",
    autoResetAll: false,
    enableRowSelection: true,
    state: {
      get sorting() {
        return sorting.value;
      },
    },
    onSortingChange: (updater) => {
      sorting.value =
        typeof updater === "function" ? updater(sorting.value) : updater;
    },
    defaultColumn: {
      minSize: 0,
      size: Number.MAX_SAFE_INTEGER,
      maxSize: Number.MAX_SAFE_INTEGER,
    },
  });

  return {
    setData(data: T[]) {
      props.data = data;
    },
    setFilter(query: string) {
      table.setGlobalFilter(query);
    },
    setSorting(state: SortingState) {
      sorting.value = state;
    },
    rows() {
      return table.getRowModel().rows;
    },
  };
}
