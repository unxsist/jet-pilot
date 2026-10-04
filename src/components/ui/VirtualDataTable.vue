<script setup lang="ts" generic="TData, TValue">
import type {
  CellContext,
  ColumnDef,
  HeaderContext,
} from "@tanstack/vue-table";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import SortAscendingIcon from "@/assets/icons/sort_asc.svg";
import SortDescendingIcon from "@/assets/icons/sort_desc.svg";
import {
  Columns3,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  TriangleAlert,
} from "lucide-vue-next";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { MassWithHandler, RowAction, WithHandler } from "../tables/types";
import { getRowIdentity } from "../tables/identity";
import { formatAge } from "../tables/age";
import type { ResourceListError } from "@/composables/useResourceList";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";

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
  allowFilter?: boolean;
  stickyHeaders?: boolean;
  autoScroll?: boolean;
  columns: ColumnDef<TData, TValue>[];
  rowActions?: RowAction<NoInfer<TData>>[];
  rowClasses?: (row: NoInfer<TData>) => string | string;
  estimatedRowHeight?: number;
  data: TData[];
  visibleColumns?: {
    [key: string]: boolean;
  };
  /** A (re)load is in progress: shows skeleton rows while there is no data. */
  loading?: boolean;
  /** Load error, shown as a persistent banner with a Retry button. */
  error?: ResourceListError | null;
  /** When the data was last refreshed successfully (shown with errors). */
  lastUpdated?: Date | null;
  /** Plural resource name for the empty state, e.g. "pods". */
  resourceName?: string;
}>();

const emit = defineEmits(["sortingChange", "rowClicked", "retry"]);

const checkboxClass =
  "border-input hover:border-foreground/50 data-[state=checked]:border-primary";

/*
 * Trailing "⋯" column: opens the same menu as right-clicking the row by
 * dispatching a contextmenu event from the button (bubbles to the row, which
 * sets the menu subject, and to the context menu trigger).
 */
const openRowMenu = (event: MouseEvent, row: TData) => {
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();

  setContextMenuSubject(row);
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    })
  );
};

const actionsColumn: ColumnDef<TData, any> = {
  id: "actions",
  size: 40,
  enableHiding: false,
  enableSorting: false,
  enableGlobalFilter: false,
  header: () => h("span", { class: "sr-only" }, "Actions"),
  cell: ({ row }) =>
    h(
      Button,
      {
        variant: "ghost",
        size: "icon",
        class: "h-7 w-7 text-muted-foreground hover:text-foreground",
        title: "Actions",
        "aria-label": "Row actions",
        onClick: (event: MouseEvent) => openRowMenu(event, row.original),
      },
      () => h(MoreHorizontal, { class: "h-4 w-4" })
    ),
};

const table = useVueTable({
  get data() {
    return props.data;
  },
  get columns() {
    return [
      {
        id: "select",
        size: 10,
        enableHiding: false,
        header: ({ table }: HeaderContext<TData, unknown>) => {
          // Only (de)select the rows that pass the current filter.
          return h(Checkbox, {
            class: checkboxClass,
            "aria-label": "Select all",
            checked: table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
              ? "indeterminate"
              : false,
            "onUpdate:checked": (checked: boolean | "indeterminate") =>
              table.toggleAllPageRowsSelected(checked === true),
          });
        },
        cell: ({ row }: CellContext<TData, unknown>) => {
          return h(Checkbox, {
            class: checkboxClass,
            "aria-label": "Select row",
            checked: row.getIsSelected(),
            "onUpdate:checked": row.getToggleSelectedHandler(),
            onClick: (e: Event) => {
              e.stopPropagation();
            },
          });
        },
      },
      ...props.columns,
      ...(props.rowActions?.length ? [actionsColumn] : []),
    ];
  },
  /*
   * Stable row ids (context + uid) so selection, row keys and the context
   * menu subject survive refreshes that reorder, add or remove rows.
   */
  getRowId: (row, index) => getRowIdentity(row) ?? String(index),
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
  enableRowSelection: true,
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

const { contexts } = injectStrict(KubeContextStateKey);

/*
 * Toggle the context / namespace columns based on the active multi-context
 * state:
 * - multiple contexts  -> show both Context and Namespace columns
 * - single context     -> show Namespace only when multiple namespaces are
 *   active or "all namespaces" is selected
 */
const toggleMultiContextColumns = () => {
  if (!table) {
    return;
  }

  const isMultiContext = contexts.value.size > 1;
  let isMultiNamespace = isMultiContext;
  if (contexts.value.size === 1) {
    const firstContext = contexts.value.values().next().value;
    if (firstContext) {
      isMultiNamespace = firstContext.length > 1 || firstContext[0] === "all";
    }
  }

  /*
   * Only touch the columns that opt in through their meta flags (a view's own
   * column may share the "namespace" id, e.g. Helm releases), and merge with
   * the current state so columns hidden by the user stay hidden.
   */
  const visibility: Record<string, boolean> = {};
  for (const column of table.getAllLeafColumns()) {
    const meta = column.columnDef.meta;
    if (meta?.showOnMultipleNamespaces) {
      visibility[column.id] = isMultiContext || isMultiNamespace;
    } else if (meta?.showOnMultipleClusters) {
      visibility[column.id] = isMultiContext;
    }
  }

  table.setColumnVisibility((current) => ({ ...current, ...visibility }));
};

watch(
  contexts,
  () => {
    toggleMultiContextColumns();
  },
  { immediate: true, deep: true }
);

const rows = computed(() => {
  return table.getRowModel().rows;
});

/* Selected rows that pass the current filter; mass actions only apply to these. */
const selectedRows = computed(() => table.getFilteredSelectedRowModel().rows);

const visibleColumnCount = computed(
  () => table.getVisibleLeafColumns().length || 1
);

const hideableColumns = computed(() =>
  table.getAllLeafColumns().filter((column) => column.getCanHide())
);

const columnLabel = (column: { id: string; columnDef: ColumnDef<TData, any> }) =>
  typeof column.columnDef.header === "string"
    ? column.columnDef.header
    : column.id;

const isFiltering = computed(() => searchQuery.value.length > 0);

const clearFilter = () => {
  searchQuery.value = "";
};

const emptyResourceName = computed(() => props.resourceName || "results");

const lastUpdatedLabel = computed(() =>
  props.lastUpdated ? formatAge(props.lastUpdated) : null
);

/* Cell tooltip: the column's own title (e.g. absolute timestamps) or the value. */
const cellTitle = (cell: {
  column: { columnDef: ColumnDef<TData, any> };
  row: { original: TData };
  getValue: () => unknown;
}) => {
  const meta = cell.column.columnDef.meta;
  if (meta?.title) {
    return meta.title(cell.row.original) || undefined;
  }

  const value = cell.getValue();
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
};

const tableContainer = ref<HTMLDivElement | null>(null);

const virtualizerOptions = computed(() => {
  return {
    count: rows.value.length,
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

const isMac = navigator.platform.toLowerCase().includes("mac");
const searchPlaceholder = `Type to filter (${isMac ? "⌘" : "Ctrl+"}F)`;
const searchFocused = ref(false);

const isEditableTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;

  return (
    element.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
    !!element.closest?.(".monaco-editor, .xterm")
  );
};

/*
 * Type-to-filter: a plain alphanumeric key press anywhere focuses the filter
 * input. Shortcuts (Cmd/Ctrl/Alt + key), typing in other fields and keys
 * pressed while text is selected are left alone so copying from e.g. the
 * describe drawer keeps working (#69). Cmd/Ctrl+F focuses the filter.
 */
const handleSearchKeyDown = (e: KeyboardEvent) => {
  if (!props.allowFilter || e.defaultPrevented) {
    return;
  }

  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.value?.focus();
    searchInput.value?.select();
    return;
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1 || !/[a-z0-9]/i.test(e.key)) return;
  if (document.activeElement === searchInput.value) return;
  if (isEditableTarget(e.target)) return;
  if (window.getSelection()?.toString()) return;

  searchInput.value?.focus();
};

const handleSearchInputKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    searchQuery.value = "";
    searchInput.value?.blur();
  }
};

watch(searchQuery, () => {
  table.setGlobalFilter(String(searchQuery.value));
});

const handleRowAction = (
  rowAction: WithHandler<TData> | MassWithHandler<TData>,
  fromContextMenu = false
) => {
  const subject = state.contextMenuSubject as TData;

  if (rowAction.massAction) {
    if (fromContextMenu) {
      rowAction.handler([subject]);
      return;
    }

    rowAction.handler(selectedRows.value.map((row) => row.original));
    table.resetRowSelection();
    return;
  }

  rowAction.handler(subject);
};

const isRowActionAvailable = (rowAction: RowAction<TData>) =>
  "isAvailable" in rowAction && rowAction.isAvailable
    ? rowAction.isAvailable(state.contextMenuSubject as TData)
    : true;

const massActions = computed(() =>
  (props.rowActions || []).filter(
    (rowAction): rowAction is MassWithHandler<TData> =>
      "massAction" in rowAction && rowAction.massAction === true
  )
);

onMounted(() => {
  window.addEventListener("keydown", handleSearchKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleSearchKeyDown);
});

const getRowClasses = (row: TData) => {
  const classes =
    typeof props.rowClasses === "function"
      ? props.rowClasses(row)
      : props.rowClasses || "";

  return [classes, hasRowClickListener.value ? "cursor-pointer" : ""].join(" ");
};

const hasRowClickListener = computed(() => {
  return !!getCurrentInstance()?.vnode.props?.onRowClicked;
});
</script>

<template>
  <div class="relative h-full flex flex-col">
    <div
      v-if="error"
      role="alert"
      class="flex items-center gap-3 px-4 py-2 border-b text-sm shrink-0"
      :class="
        error.fatal
          ? 'bg-destructive/10 border-destructive/30'
          : 'bg-amber-500/10 border-amber-500/30'
      "
    >
      <TriangleAlert
        class="h-4 w-4 shrink-0"
        :class="
          error.fatal ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'
        "
      />
      <div class="min-w-0 flex-1">
        <div class="truncate text-foreground" :title="error.message">
          {{ error.message }}
        </div>
        <div v-if="error.fatal" class="text-xs text-muted-foreground">
          Auto-refresh paused<template v-if="lastUpdatedLabel">
            · showing data from {{ lastUpdatedLabel }} ago</template
          >
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="shrink-0"
        :disabled="loading"
        @click="emit('retry')"
      >
        <Loader2 v-if="loading" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5 mr-1.5" />
        Retry
      </Button>
    </div>
    <div ref="tableContainer" class="relative flex-1 min-h-0 overflow-auto">
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
                        <span
                          v-else-if="header.column.getIsSorted() === 'desc'"
                        >
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
                    v-for="column in hideableColumns"
                    :key="column.id"
                    :checked="column.getIsVisible()"
                    @select="column.toggleVisibility()"
                  >
                    {{ columnLabel(column) }}
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
                      :colspan="visibleColumnCount"
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
                    :class="getRowClasses(rows[row.index].original)"
                    @click.right="
                      setContextMenuSubject(rows[row.index].original)
                    "
                    @click.left="emit('rowClicked', rows[row.index].original)"
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
                      :title="cellTitle(cell)"
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
                      :colspan="visibleColumnCount"
                      :style="{ height: `${after}px` }"
                    />
                  </tr>
                </template>
                <template v-else-if="loading && data.length === 0">
                  <TableRow
                    v-for="index in 8"
                    :key="`skeleton-${index}`"
                    class="hover:bg-transparent"
                    aria-hidden="true"
                  >
                    <TableCell
                      v-for="column in table.getVisibleLeafColumns()"
                      :key="column.id"
                    >
                      <Skeleton
                        class="h-4"
                        :class="column.id === 'select' ? 'w-4' : 'w-3/4'"
                      />
                    </TableCell>
                  </TableRow>
                </template>
                <template v-else>
                  <TableRow class="hover:bg-transparent">
                    <TableCell
                      :colspan="visibleColumnCount"
                      class="h-24 text-center text-muted-foreground"
                    >
                      <template v-if="data.length > 0 && isFiltering">
                        No matches for “{{ searchQuery }}” ·
                        <button
                          class="text-primary hover:underline"
                          @click.stop="clearFilter"
                        >
                          clear filter
                        </button>
                        (Esc)
                      </template>
                      <template v-else-if="error?.fatal">
                        Could not load {{ emptyResourceName }}.
                      </template>
                      <template v-else>
                        No {{ emptyResourceName }} found.
                      </template>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </ContextMenuTrigger>
            <ContextMenuContent v-if="rowActions && rowActions?.length > 0">
              <template v-for="(rowAction, index) in rowActions" :key="index">
                <template v-if="!rowAction.options">
                  <ContextMenuItem
                    v-if="isRowActionAvailable(rowAction)"
                    @select="handleRowAction(rowAction, true)"
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
                        @select="handleRowAction(option, true)"
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
    </div>
    <div
      class="bottom-5 flex items-center absolute right-4 left-4 z-50 overflow-hidden"
    >
      <div v-if="allowFilter" class="w-1/3 flex items-center gap-2">
        <input
          ref="searchInput"
          v-model="searchQuery"
          :class="{
            'w-48 h-8 text-xs opacity-60 border-muted':
              searchQuery.length === 0 && !searchFocused,
            'w-full h-10 border-primary':
              searchQuery.length > 0 || searchFocused,
          }"
          class="transition-all py-2 px-4 bg-background border focus:border-2 rounded-full focus:outline-none"
          :placeholder="searchPlaceholder"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @keydown="handleSearchInputKeydown"
        />
        <span
          v-if="isFiltering"
          class="shrink-0 text-xs text-muted-foreground bg-background/80 rounded-full px-2 py-1"
        >
          {{ rows.length }} of {{ data.length }}
        </span>
        <DropdownMenu v-if="hideableColumns.length > 0">
          <DropdownMenuTrigger as-child>
            <button
              class="shrink-0 flex items-center gap-1.5 h-8 px-3 text-xs rounded-full border border-muted bg-background opacity-60 hover:opacity-100 transition-all"
              title="Show / hide columns"
            >
              <Columns3 class="h-3.5 w-3.5" />
              Columns
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              v-for="column in hideableColumns"
              :key="column.id"
              :checked="column.getIsVisible()"
              @select="(event: Event) => event.preventDefault()"
              @update:checked="(checked: boolean) => column.toggleVisibility(checked)"
            >
              {{ columnLabel(column) }}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        class="ml-auto flex items-center justify-between px-4 h-10 border bg-background rounded-full transition-all"
        :class="{
          'translate-y-0': selectedRows.length > 0,
          'translate-y-full': selectedRows.length === 0,
        }"
      >
        <div class="mr-4">{{ selectedRows.length }} selected</div>
        <div class="space-x-2 -mr-2">
          <template v-for="(rowAction, index) in massActions" :key="index">
            <Button
              class="rounded-full"
              @click="handleRowAction(rowAction)"
              size="xs"
              >{{ rowAction.label }}</Button
            >
          </template>
        </div>
      </div>

      <slot name="action-buttons" />
    </div>
  </div>
</template>
