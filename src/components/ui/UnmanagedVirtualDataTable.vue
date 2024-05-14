<script setup lang="ts" generic="TData, TValue">
import type { ColumnDef } from "@tanstack/vue-table";
import { UnwrapRef } from "vue";
import {
  FlexRender,
  getCoreRowModel,
  useVueTable,
  SortingState,
} from "@tanstack/vue-table";
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

const sorting = ref<SortingState>([]);
const state = reactive<DataTableState<TData>>({
  contextMenuSubject: null,
});

const setContextMenuSubject = (subject: TData | null) => {
  state.contextMenuSubject = subject as UnwrapRef<TData>;
};

const props = defineProps<{
  stickyHeaders?: boolean;
  columns: ColumnDef<TData, TValue>[];
  rowActions?: RowAction<TData>[];
  rowClasses?: (row: TData) => string | string;
  data: TData[];
  visibleColumns?: {
    [key: string]: boolean;
  };
  dataLength: number;
  estimatedRowHeight: number;
  scrollOffset: number;
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
</script>

<template>
  <div
    class="relative"
    :style="{ height: `${dataLength * estimatedRowHeight}px` }"
  >
    <Table class="absolute w-full" :style="{ top: `${scrollOffset}px` }">
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
                  header.column.getCanSort() ? 'cursor-pointer select-none' : ''
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
              <TableRow
                v-for="row in table.getRowModel().rows"
                :key="row.key"
                :data-state="row.getIsSelected() ? 'selected' : undefined"
                :class="
                  typeof rowClasses === 'function'
                    ? rowClasses(row.original)
                    : rowClasses || ''
                "
                @click.right="setContextMenuSubject(row.original)"
              >
                <TableCell
                  v-for="cell in table
                    .getRowModel()
                    .rows[row.index].getVisibleCells()"
                  :key="cell.id"
                  :class="cell.column.columnDef.meta?.class?.(row.original)"
                  class="truncate overflow-hidden"
                >
                  <FlexRender
                    :render="cell.column.columnDef.cell"
                    :props="cell.getContext()"
                  />
                </TableCell>
              </TableRow>
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
</template>
