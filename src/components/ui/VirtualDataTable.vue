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
  ContextMenuSeparator,
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
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import KindIcon from "@/components/KindIcon.vue";
import { actionIcon, isDestructiveAction } from "@/lib/actionIcons";
import {
  ArrowDown,
  ArrowUp,
  CloudOff,
  Columns3,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  SearchX,
  TriangleAlert,
  X,
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
import { type as getOsType } from "@tauri-apps/plugin-os";
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

/*
 * Row checkboxes stay out of the way until the row is hovered / focused, or
 * while any row is selected (see the table container class).
 */
const checkboxClass =
  "row-checkbox opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=checked]:opacity-100";

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
  size: 44,
  enableHiding: false,
  enableSorting: false,
  enableGlobalFilter: false,
  header: () => h("span", { class: "sr-only" }, "Actions"),
  cell: ({ row }) =>
    h(
      Button,
      {
        variant: "ghost",
        size: "icon-xs",
        class:
          "text-muted-foreground opacity-0 transition-opacity duration-fast hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100",
        title: "Actions",
        "aria-label": "Row actions",
        onClick: (event: MouseEvent) => openRowMenu(event, row.original),
      },
      () => h(MoreHorizontal, { class: "h-3.5 w-3.5" })
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
        size: 32,
        enableHiding: false,
        header: ({ table }: HeaderContext<TData, unknown>) => {
          // Only (de)select the rows that pass the current filter.
          return h(Checkbox, {
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
/* Cluster-scoped kinds (nodes, persistent volumes, ...) have no namespace. */
const hasNamespacedRows = computed(
  () =>
    props.data.length === 0 ||
    props.data.some(
      (row) => !!(row as { metadata?: { namespace?: string } })?.metadata?.namespace
    )
);

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
      visibility[column.id] =
        (isMultiContext || isMultiNamespace) && hasNamespacedRows.value;
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

// Only fires when the data switches between namespaced / cluster-scoped.
watch(hasNamespacedRows, () => toggleMultiContextColumns());

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

/* Dense rows (~34px); views with taller cells pass their own height. */
const rowHeight = computed(() => props.estimatedRowHeight || 34);

const skeletonWidths = ["w-3/4", "w-1/2", "w-2/3", "w-5/12"];

/* The object name column carries the row: medium weight, full contrast. */
const PRIMARY_COLUMN_IDS = new Set(["metadata_name", "name", "Name"]);

const virtualizerOptions = computed(() => {
  return {
    count: rows.value.length,
    getScrollElement: () => tableContainer.value,
    estimateSize: () => rowHeight.value,
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

const isMac = getOsType() === "macos";
const searchPlaceholder = computed(() => `Filter ${emptyResourceName.value}…`);

/* Label of a row action; function labels depend on the menu subject. */
const actionLabel = (rowAction: RowAction<TData>): string => {
  if (typeof rowAction.label === "string") {
    return rowAction.label;
  }

  const subject =
    (state.contextMenuSubject as TData | null) ??
    selectedRows.value[0]?.original;
  return subject ? rowAction.label(subject) : "";
};

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

  return [
    "group/row",
    classes,
    hasRowClickListener.value ? "cursor-pointer" : "",
  ].join(" ");
};

const hasRowClickListener = computed(() => {
  return !!getCurrentInstance()?.vnode.props?.onRowClicked;
});
</script>

<template>
  <div class="relative flex h-full flex-col">
    <!-- Toolbar: filter, count, columns and view actions -->
    <div
      v-if="allowFilter"
      class="flex h-11 shrink-0 items-center gap-2 border-b px-3"
    >
      <div class="relative flex w-full max-w-[18rem] items-center">
        <Search
          class="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          ref="searchInput"
          v-model="searchQuery"
          :placeholder="searchPlaceholder"
          :aria-label="`Filter ${emptyResourceName}`"
          :aria-keyshortcuts="isMac ? 'Meta+F' : 'Control+F'"
          class="h-7 w-full rounded-md border border-input bg-background pl-8 pr-16 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-fast ease-out placeholder:text-muted-foreground/80 hover:border-border-strong focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20"
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @keydown="handleSearchInputKeydown"
        />
        <div class="absolute right-1.5 flex items-center">
          <button
            v-if="isFiltering"
            type="button"
            class="flex h-5 items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-ring"
            aria-label="Clear filter"
            title="Clear filter (Esc)"
            @click="clearFilter"
          >
            <X class="h-3 w-3" />
          </button>
          <Kbd v-else :keys="isMac ? ['⌘', 'F'] : ['Ctrl', 'F']" size="sm" />
        </div>
      </div>
      <span
        class="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        <template v-if="isFiltering">
          <span class="font-medium text-foreground">{{ rows.length }}</span>
          of {{ data.length }}
        </template>
        <template v-else-if="data.length > 0">
          {{ data.length }} {{ emptyResourceName }}
        </template>
      </span>
      <Loader2
        v-if="loading && data.length > 0"
        class="h-3.5 w-3.5 animate-spin text-muted-foreground"
        aria-label="Refreshing"
      />
      <div class="ml-auto flex items-center gap-1.5">
        <DropdownMenu v-if="hideableColumns.length > 0">
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground"
              title="Show / hide columns"
            >
              <Columns3 class="h-3.5 w-3.5" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="min-w-[12rem]">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
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
        <slot name="action-buttons" />
      </div>
    </div>

    <!-- Load error banner -->
    <div
      v-if="error"
      role="alert"
      class="flex shrink-0 items-start gap-3 border-b px-4 py-2.5 text-sm"
      :class="
        error.fatal
          ? 'border-destructive/20 bg-destructive/[0.06]'
          : 'border-warning/20 bg-warning/[0.06]'
      "
    >
      <span
        class="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        :class="
          error.fatal
            ? 'bg-destructive/15 text-destructive'
            : 'bg-warning/15 text-warning'
        "
      >
        <TriangleAlert class="h-3 w-3" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="font-medium text-foreground">
          {{
            error.fatal
              ? `Couldn't load ${emptyResourceName}`
              : "Some contexts failed to load"
          }}
        </div>
        <div
          class="mt-0.5 truncate font-mono text-xs text-muted-foreground select-text"
          :title="error.message"
        >
          {{ error.message }}
        </div>
        <div v-if="error.fatal" class="mt-0.5 text-xs text-muted-foreground">
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
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        Retry
      </Button>
    </div>

    <div
      ref="tableContainer"
      class="relative min-h-0 flex-1 overflow-auto"
      :class="{ '[&_.row-checkbox]:opacity-100': selectedRows.length > 0 }"
    >
      <div :style="{ height: `${totalSize}px` }">
        <Table class="w-full">
          <ContextMenu>
            <ContextMenuTrigger as-child>
              <TableHeader>
                <TableRow
                  v-for="headerGroup in table.getHeaderGroups()"
                  :key="headerGroup.id"
                  class="border-b-0 hover:bg-transparent"
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
                    :numeric="header.column.columnDef.meta?.numeric"
                    :aria-sort="
                      header.column.getIsSorted() === 'asc'
                        ? 'ascending'
                        : header.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : undefined
                    "
                    :class="[
                      stickyHeaders ? 'bg-background' : '',
                      header.column.id === 'select' ? 'pl-3' : '',
                      header.column.getCanSort()
                        ? 'cursor-pointer select-none transition-colors duration-fast hover:text-foreground'
                        : '',
                      header.column.getIsSorted() ? 'text-foreground' : '',
                    ].join(' ')"
                    @click="header.column.getToggleSortingHandler()?.($event)"
                  >
                    <div
                      class="inline-flex items-center gap-1"
                      :class="{
                        'flex-row-reverse':
                          header.column.columnDef.meta?.numeric,
                      }"
                    >
                      <FlexRender
                        v-if="!header.isPlaceholder"
                        :render="header.column.columnDef.header"
                        :props="header.getContext()"
                      />
                      <ArrowUp
                        v-if="header.column.getIsSorted() === 'asc'"
                        class="h-3 w-3"
                        aria-hidden="true"
                      />
                      <ArrowDown
                        v-else-if="header.column.getIsSorted() === 'desc'"
                        class="h-3 w-3"
                        aria-hidden="true"
                      />
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Columns3 class="h-3.5 w-3.5 text-muted-foreground" />
                  Columns
                </ContextMenuSubTrigger>
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
                      :numeric="cell.column.columnDef.meta?.numeric"
                      :class="[
                        cell.column.columnDef.meta?.class?.(
                          rows[row.index].original
                        ),
                        cell.column.id === 'select' ? 'pl-3' : '',
                        cell.column.id === 'actions' ? 'px-1.5 text-right' : '',
                        PRIMARY_COLUMN_IDS.has(cell.column.id)
                          ? 'font-medium text-foreground'
                          : '',
                      ]"
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
                    v-for="index in 10"
                    :key="`skeleton-${index}`"
                    class="hover:bg-transparent"
                    :style="{ height: `${rowHeight}px` }"
                    aria-hidden="true"
                  >
                    <TableCell
                      v-for="(column, columnIndex) in table.getVisibleLeafColumns()"
                      :key="column.id"
                      :class="column.id === 'select' ? 'pl-3' : ''"
                    >
                      <Skeleton
                        class="h-3"
                        :class="
                          column.id === 'select'
                            ? 'w-4'
                            : column.id === 'actions'
                            ? 'w-0'
                            : skeletonWidths[(index + columnIndex) % 4]
                        "
                        :style="{ opacity: 1 - index * 0.07 }"
                      />
                    </TableCell>
                  </TableRow>
                </template>
                <template v-else>
                  <TableRow class="border-b-0 hover:bg-transparent">
                    <TableCell :colspan="visibleColumnCount" class="p-0">
                      <EmptyState
                        v-if="data.length > 0 && isFiltering"
                        :icon="SearchX"
                        title="No matches"
                      >
                        No {{ emptyResourceName }} match “{{ searchQuery }}”.
                        <template #action>
                          <Button
                            variant="outline"
                            size="sm"
                            @click.stop="clearFilter"
                          >
                            Clear filter
                            <Kbd size="sm">Esc</Kbd>
                          </Button>
                        </template>
                      </EmptyState>
                      <EmptyState
                        v-else-if="error?.fatal"
                        :icon="CloudOff"
                        :title="`Couldn't load ${emptyResourceName}`"
                        description="Check your connection to the cluster, then retry."
                      >
                        <template #action>
                          <Button
                            variant="outline"
                            size="sm"
                            :disabled="loading"
                            @click.stop="emit('retry')"
                          >
                            <RefreshCw class="h-3.5 w-3.5" />
                            Retry
                          </Button>
                        </template>
                      </EmptyState>
                      <EmptyState
                        v-else
                        :title="`No ${emptyResourceName}`"
                        description="Nothing to show for the selected contexts and namespaces."
                      >
                        <template #icon>
                          <KindIcon :name="emptyResourceName" />
                        </template>
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </ContextMenuTrigger>
            <ContextMenuContent
              v-if="rowActions && rowActions?.length > 0"
              class="min-w-[12rem]"
            >
              <template v-for="(rowAction, index) in rowActions" :key="index">
                <template v-if="!rowAction.options">
                  <ContextMenuSeparator
                    v-if="
                      isDestructiveAction(actionLabel(rowAction)) &&
                      index > 0 &&
                      !isDestructiveAction(actionLabel(rowActions[index - 1]))
                    "
                  />
                  <ContextMenuItem
                    v-if="isRowActionAvailable(rowAction)"
                    :variant="
                      isDestructiveAction(actionLabel(rowAction))
                        ? 'destructive'
                        : 'default'
                    "
                    @select="handleRowAction(rowAction, true)"
                  >
                    <component
                      :is="actionIcon(actionLabel(rowAction))"
                      v-if="actionIcon(actionLabel(rowAction))"
                      class="h-3.5 w-3.5"
                      :class="
                        isDestructiveAction(actionLabel(rowAction))
                          ? ''
                          : 'text-muted-foreground'
                      "
                    />
                    <span v-else class="w-3.5" aria-hidden="true" />
                    {{ actionLabel(rowAction) }}
                  </ContextMenuItem>
                </template>
                <template v-else>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <component
                        :is="actionIcon(actionLabel(rowAction))"
                        v-if="actionIcon(actionLabel(rowAction))"
                        class="h-3.5 w-3.5 text-muted-foreground"
                      />
                      <span v-else class="w-3.5" aria-hidden="true" />
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

    <!-- Selection bar: mass actions for the selected (filtered) rows -->
    <Transition
      enter-active-class="transition duration-base ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-fast ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="selectedRows.length > 0"
        class="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-popover p-1 pl-3 text-sm shadow-lg"
        role="toolbar"
        aria-label="Selected rows"
      >
        <span class="mr-1 whitespace-nowrap tabular-nums text-muted-foreground">
          <span class="font-medium text-foreground">{{
            selectedRows.length
          }}</span>
          selected
        </span>
        <span class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <Button
          v-for="(rowAction, index) in massActions"
          :key="index"
          size="xs"
          :variant="
            isDestructiveAction(actionLabel(rowAction)) ? 'destructive' : 'ghost'
          "
          @click="handleRowAction(rowAction)"
        >
          <component
            :is="actionIcon(actionLabel(rowAction))"
            v-if="actionIcon(actionLabel(rowAction))"
            class="h-3 w-3"
          />
          {{ actionLabel(rowAction) }}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          aria-label="Clear selection"
          title="Clear selection"
          @click="table.resetRowSelection()"
        >
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>
    </Transition>
  </div>
</template>
