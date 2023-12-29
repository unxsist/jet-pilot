<script setup lang="ts" generic="TData, TValue">
import type { ColumnDef } from "@tanstack/vue-table";
import { UnwrapRef } from "vue";
import { FlexRender, getCoreRowModel, useVueTable } from "@tanstack/vue-table";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RowAction } from "../tables/types";
import { rowActions } from "../tables/pods";

interface DataTableState<T> {
  contextMenuSubject: T | null;
}

const state = reactive<DataTableState<TData>>({
  contextMenuSubject: null,
});

const setContextMenuSubject = (subject: TData | null) => {
  state.contextMenuSubject = subject as UnwrapRef<TData>;
};

const props = defineProps<{
  columns: ColumnDef<TData, TValue>[];
  rowActions?: RowAction<TData>[];
  data: TData[];
}>();

const table = useVueTable({
  get data() {
    return props.data;
  },
  get columns() {
    return props.columns;
  },
  getCoreRowModel: getCoreRowModel(),
});
</script>

<template>
  <Table class="w-full">
    <TableHeader>
      <TableRow
        v-for="headerGroup in table.getHeaderGroups()"
        :key="headerGroup.id"
      >
        <TableHead
          v-bind:enable-header-drag-region="true"
          v-for="header in headerGroup.headers"
          :key="header.id"
        >
          <FlexRender
            v-if="!header.isPlaceholder"
            :render="header.column.columnDef.header"
            :props="header.getContext()"
          />
        </TableHead>
      </TableRow>
    </TableHeader>
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <TableBody>
          <template v-if="table.getRowModel().rows?.length">
            <TableRow
              v-for="row in table.getRowModel().rows"
              :key="row.id"
              :data-state="row.getIsSelected() ? 'selected' : undefined"
              @click.right="setContextMenuSubject(row.original)"
            >
              <TableCell
                v-for="cell in row.getVisibleCells()"
                :key="cell.id"
                :class="cell.column.columnDef.meta?.class"
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
      <ContextMenuContent>
        <ContextMenuItem
          v-for="(rowAction, index) in rowActions"
          :key="index"
          @select="rowAction.handler(state.contextMenuSubject as TData)"
          >{{ rowAction.label }}</ContextMenuItem
        >
      </ContextMenuContent>
    </ContextMenu>
  </Table>
</template>
