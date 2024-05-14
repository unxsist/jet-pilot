<script setup lang="ts" generic="TData, TValue">
import type { ColumnDef } from "@tanstack/vue-table";
import { UnwrapRef } from "vue";
import {
  FlexRender,
  getCoreRowModel,
  useVueTable,
  SortingState,
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
  },
  getCoreRowModel: getCoreRowModel(),
  manualSorting: true,
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
                  v-bind:enable-header-drag-region="true"
                  v-for="header in headerGroup.headers"
                  :key="header.id"
                  :style="{ width: `${header.getSize()}px` }"
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
                        <SortAscendingIcon class="w-4 h-4" />
                      </span>
                      <span v-else-if="header.column.getIsSorted() === 'desc'">
                        <SortDescendingIcon class="w-4 h-4" />
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
                  :checked="column.getIsVisible()"
                  v-for="column in table.getAllColumns()"
                  :key="column.id"
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
              <template v-if="table.getRowModel().rows?.length">
                <tr v-if="before > 0">
                  <td
                    colspan="columns.length"
                    :style="{ height: `${before}px` }"
                  />
                </tr>
                <TableRow
                  v-for="row in virtualRows"
                  :key="row.key"
                  :data-state="
                    table.getRowModel().rows[row.index].getIsSelected()
                      ? 'selected'
                      : undefined
                  "
                  :class="
                    typeof rowClasses === 'function'
                      ? rowClasses(table.getRowModel().rows[row.index].original)
                      : rowClasses || ''
                  "
                  @click.right="
                    setContextMenuSubject(
                      table.getRowModel().rows[row.index].original
                    )
                  "
                >
                  <TableCell
                    v-for="cell in table
                      .getRowModel()
                      .rows[row.index].getVisibleCells()"
                    :key="cell.id"
                    :class="
                      cell.column.columnDef.meta?.class?.(
                        table.getRowModel().rows[row.index].original
                      )
                    "
                    class="truncate overflow-hidden"
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
              <ContextMenuItem
                v-if="!rowAction.options"
                @select="rowAction.handler(state.contextMenuSubject as TData)"
                >{{ rowAction.label }}</ContextMenuItem
              >
              <ContextMenuSub v-else>
                <ContextMenuSubTrigger>
                  {{ rowAction.label }}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem
                    v-for="(option, optionIndex) in rowAction.options(state.contextMenuSubject as TData)"
                    :key="optionIndex"
                    @select="option.handler(state.contextMenuSubject as TData)"
                    >{{ option.label }}</ContextMenuItem
                  >
                </ContextMenuSubContent>
              </ContextMenuSub>
            </template>
          </ContextMenuContent>
        </ContextMenu>
      </Table>
    </div>
  </div>
</template>
