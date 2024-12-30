<script setup lang="ts" generic="TData, TValue">
import type { ColumnDef } from "@tanstack/vue-table";
import { UnwrapRef } from "vue";
import {
  FlexRender,
  getCoreRowModel,
  getSortedRowModel,
  useVueTable,
  SortingState,
  getFilteredRowModel,
} from "@tanstack/vue-table";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import SortAscendingIcon from "@/assets/icons/sort_asc.svg";
import SortDescendingIcon from "@/assets/icons/sort_desc.svg";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RowAction } from "../tables/types";

interface DataTableState<T> {
  contextMenuSubject: T | null;
}

const state = reactive<DataTableState<TData>>({
  contextMenuSubject: null,
});

const setContextMenuSubject = (subject: TData | null) => {
  state.contextMenuSubject = subject as UnwrapRef<TData>;
};

const sorting = ref<SortingState>([]);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref<string>("");

const props = defineProps<{
  stickyHeaders?: boolean;
  autoScroll?: boolean;
  columns: ColumnDef<TData, TValue>[];
  rowActions?: RowAction<TData>[];
  rowClasses?: (row: TData) => string | string;
  estimatedRowHeight?: number;
  data: TData[];
  visibleColumns?: {
    [key: string]: boolean;
  };
}>();

const emit = defineEmits(["sortingChange"]);

const table = useVueTable({
  get data() {
    return props.data;
  },
  get columns() {
    return props.columns;
  },
  initialState: {
    columnVisibility: props.visibleColumns,
    sorting: [
      {
        id: "Name",
        desc: true,
      },
    ],
  },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  globalFilterFn: "includesString",
  autoResetAll: false,
  manualSorting: false,
  state: {
    get sorting() {
      return sorting.value;
    },
  },
  onSortingChange: (newSorting) => {
    sorting.value =
      typeof newSorting === "function" ? newSorting(sorting.value) : newSorting;
    emit("sortingChange", sorting.value);
  },
  defaultColumn: {
    minSize: 0,
    size: Number.MAX_SAFE_INTEGER,
    maxSize: Number.MAX_SAFE_INTEGER,
  },
});

const rows = computed(() => {
  return table.getRowModel().rows;
});

const tableContainer = ref<HTMLDivElement | null>(null);

const virtualizerOptions = computed(() => {
  return {
    count: props.data.length,
    getScrollElement: () => tableContainer.value,
    estimateSize: () => props.estimatedRowHeight || 37,
    overscan: 5,
  };
});

const virtualizer = useVirtualizer(virtualizerOptions);

const virtualRows = computed(() => virtualizer.value.getVirtualItems());

const totalSize = computed(() => {
  return virtualizer.value.getTotalSize();
});

watch(
  () => props.data.length,
  () => {
    if (props.autoScroll) {
      nextTick(() => {
        if (tableContainer.value) {
          tableContainer.value.scrollTop = tableContainer.value.scrollHeight;
        }
      });
    }
  }
);

const before = computed(() => {
  return virtualRows.value.length > 0
    ? Math.max(
        0,
        virtualRows.value[0].start - virtualizer.value.options.scrollMargin
      )
    : 0;
});

const after = computed(() => {
  return virtualRows.value.length > 0
    ? virtualizer.value.getTotalSize() -
        Math.max(0, virtualRows.value[virtualRows.value.length - 1].end)
    : 0;
});

const handleSearchKeyDown = (e: KeyboardEvent) => {
  if (searchQuery.value.length === 0 && e.key.match(/[a-z0-9]/i)) {
    searchInput.value?.focus();
    window.removeEventListener("keydown", handleSearchKeyDown);
  }
};

const handleSearchInputKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    searchQuery.value = "";
    searchInput.value?.blur();
  }
};

watch(searchQuery, () => {
  if (searchQuery.value.length === 0) {
    window.addEventListener("keydown", handleSearchKeyDown);
  } else {
    table.setGlobalFilter(searchQuery.value);
  }
});

onMounted(() => {
  // window.addEventListener("keydown", handleSearchKeyDown);
});
</script>

<template>
  <div ref="tableContainer" class="h-full overflow-auto">
    <div :style="{ height: `${totalSize}px` }">
      <Table class="w-full">
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <TableHeader>
              <TableRow
                v-for="headerGroup in table.getHeaderGroups()"
                :key="headerGroup.id"
              >
                <TableHead
                  v-for="header in headerGroup.headers"
                  :key="header.id"
                  v-bind:enable-header-drag-region="true"
                  :style="{
                    width:
                      header.getSize() === Number.MAX_SAFE_INTEGER
                        ? 'auto'
                        : `${header.getSize()}px`,
                  }"
                  :sticky="stickyHeaders === true"
                  :class="
                    header.column.getCanSort()
                      ? 'cursor-pointer select-none'
                      : ''
                  "
                  @click="header.column.getToggleSortingHandler()?.($event)"
                >
                  <div class="flex justify-between items-center">
                    <FlexRender
                      v-if="!header.isPlaceholder"
                      :render="header.column.columnDef.header"
                      :props="header.getContext()"
                    />
                    <div class="ml-2">
                      <span v-if="header.column.getIsSorted() === 'asc'">
                        <SortDescendingIcon class="w-4 h-4" />
                      </span>
                      <span v-else-if="header.column.getIsSorted() === 'desc'">
                        <SortAscendingIcon class="w-4 h-4" />
                      </span>
                    </div>
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Columns</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuCheckboxItem
                  v-for="column in table.getAllColumns()"
                  :key="column.id"
                  :checked="column.getIsVisible()"
                  @select="
                    table.setColumnVisibility({
                      [column.id]: !column.getIsVisible(),
                    })
                  "
                >
                  {{ column.columnDef.header }}
                </ContextMenuCheckboxItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <TableBody>
              <template v-if="rows?.length">
                <tr v-if="before > 0">
                  <td
                    colspan="columns.length"
                    :style="{ height: `${before}px` }"
                  />
                </tr>
                <TableRow
                  v-for="row in virtualRows"
                  :key="rows[row.index].id"
                  :style="{
                    height: `${row.size}px`,
                    transform: `translateY(${
                      row.start - row.index * row.size
                    }px)`,
                  }"
                  :data-state="
                    rows[row.index].getIsSelected() ? 'selected' : undefined
                  "
                  :class="
                    typeof rowClasses === 'function'
                      ? rowClasses(rows[row.index].original)
                      : rowClasses || ''
                  "
                  @click.right="setContextMenuSubject(rows[row.index].original)"
                >
                  <TableCell
                    v-for="cell in rows[row.index].getVisibleCells()"
                    :key="cell.id"
                    :class="
                      cell.column.columnDef.meta?.class?.(
                        rows[row.index].original
                      )
                    "
                    class="truncate overflow-hidden"
                    :columnDef="cell.column.columnDef"
                    :style="{
                      maxWidth:
                        cell.column.getSize() === Number.MAX_SAFE_INTEGER
                          ? 'auto'
                          : `${cell.column.columnDef.size}px`,
                    }"
                  >
                    <FlexRender
                      :render="cell.column.columnDef.cell"
                      :props="cell.getContext()"
                    />
                  </TableCell>
                </TableRow>
                <tr v-if="after > 0">
                  <td
                    colspan="columns.length"
                    :style="{ height: `${after}px` }"
                  />
                </tr>
              </template>
              <template v-else>
                <TableRow>
                  <TableCell :colSpan="columns.length" class="h-24 text-center">
                    No results.
                  </TableCell>
                </TableRow>
              </template>
            </TableBody>
          </ContextMenuTrigger>
          <ContextMenuContent v-if="rowActions && rowActions?.length > 0">
            <template v-for="(rowAction, index) in rowActions" :key="index">
              <template v-if="!rowAction.options">
                <ContextMenuItem
                  v-if="rowAction.isAvailable ? rowAction.isAvailable(state.contextMenuSubject as TData) : true"
                  @select="rowAction.handler(state.contextMenuSubject as TData)"
                  >{{
                    typeof rowAction.label === "function"
                      ? rowAction.label(state.contextMenuSubject as TData)
                      : rowAction.label
                  }}</ContextMenuItem
                >
              </template>
              <template v-else>
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    {{ rowAction.label }}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem
                      v-for="(option, optionIndex) in rowAction.options(state.contextMenuSubject as TData)"
                      :key="optionIndex"
                      @select="
                        option.handler(state.contextMenuSubject as TData)
                      "
                      >{{ option.label }}</ContextMenuItem
                    >
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </template>
            </template>
          </ContextMenuContent>
        </ContextMenu>
      </Table>
    </div>
    <div class="absolute rounded z-50 bottom-4 right-4" v-if="false">
      <input
        v-model="searchQuery"
        :class="{ 'opacity-0 pointer-events-none': searchQuery.length === 0 }"
        class="w-full h-10 px-2 text-lg bg-background border border-border rounded"
        placeholder="Search"
        ref="searchInput"
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        @keydown="handleSearchInputKeydown"
      />
    </div>
  </div>
</template>
