<script setup lang="ts" generic="TData, TValue">
import type {
  Column,
  ColumnDef,
  Header,
  Row,
  RowSelectionState,
  SortingState,
} from "@tanstack/vue-table";
import { FlexRender } from "@tanstack/vue-table";
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
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import KindIcon from "@/components/KindIcon.vue";
import { actionIcon, isDestructiveAction } from "@/lib/actionIcons";
import { blockedReason, type ClusterRef } from "@/lib/guardrails/menu";
import { guardedCluster } from "@/lib/guardrails/backstop";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CloudOff,
  Columns3,
  Copy,
  Keyboard,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-vue-next";

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { MassWithHandler, RowAction, WithHandler } from "../tables/types";
import { formatAge } from "../tables/age";
import { useTableModel } from "../tables/useTableModel";
import {
  actionIdForLabel,
  actionKeys,
  clampIndex,
  findRowAction,
  isActivatable,
  isEditableTarget,
  isInKeyboardScope,
  isInOverlay,
  rangeIds,
  resolveTableKey,
  rowActionLabel,
  type ActionId,
  type TableCommand,
} from "../tables/keyboard";
import {
  clampWidth,
  loadTablePrefs,
  moveColumn,
  resolveColumnOrder,
  saveTablePrefs,
  type TablePrefs,
} from "../tables/columnPrefs";
import {
  availableGroupOptions,
  buildDisplayItems,
  groupOption,
  type DisplayItem,
} from "../tables/grouping";
import {
  collectPrinterColumns,
  printerColumnDefs,
  printerColumnsSignature,
} from "../tables/printerColumns";
import TableShortcutsDialog from "../tables/TableShortcutsDialog.vue";
import RowOptionPicker from "../tables/RowOptionPicker.vue";
import type { ResourceListError } from "@/composables/useResourceList";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { injectStrict } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    allowFilter?: boolean;
    stickyHeaders?: boolean;
    autoScroll?: boolean;
    columns: ColumnDef<TData, TValue>[];
    rowActions?: RowAction<NoInfer<TData>>[];
    rowClasses?: (row: NoInfer<TData>) => string | string;
    /** Fixed row height in px (rows are virtualised at exactly this height). */
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
    /**
     * Key for persisted column order / widths / visibility / grouping
     * (localStorage `jet.table.<key>`). Defaults to `resourceName` for
     * filterable tables; pass an empty string to disable.
     */
    persistKey?: string;
    /**
     * k9s-style keyboard navigation (row cursor, j/k, Enter, l/s/e/d/y, ...).
     * Defaults to on for filterable tables with row actions or a row click.
     */
    keyboard?: boolean;
  }>(),
  // undefined (not false): the keyboard default depends on the other props
  { keyboard: undefined, persistKey: undefined }
);

const emit = defineEmits(["sortingChange", "rowClicked", "retry"]);

const instance = getCurrentInstance();
const hasRowClickListener = computed(
  () => !!instance?.vnode.props?.onRowClicked
);

const isMac = getOsType() === "macos";

const sorting = ref<SortingState>([]);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref<string>("");
const root = ref<HTMLDivElement | null>(null);
const tableContainer = ref<HTMLDivElement | null>(null);

/* Context menu subject: never wrapped in a deep reactive proxy. */
const contextMenuSubject = shallowRef<TData | null>(null);
const setContextMenuSubject = (subject: TData | null) => {
  contextMenuSubject.value = subject;
};

/* ------------------------------------------------------------ prefs -- */

const prefsKind = computed(() =>
  props.persistKey !== undefined
    ? props.persistKey
    : props.allowFilter
      ? props.resourceName || ""
      : ""
);

const prefs = ref<TablePrefs>(
  prefsKind.value ? loadTablePrefs(prefsKind.value) : {}
);

watch(prefsKind, (kind) => {
  prefs.value = kind ? loadTablePrefs(kind) : {};
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  prefs,
  (value) => {
    const kind = prefsKind.value;
    if (!kind) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveTablePrefs(kind, value), 250);
  },
  { deep: true }
);

const updatePrefs = (patch: Partial<TablePrefs>) => {
  prefs.value = { ...prefs.value, ...patch };
};

/* ---------------------------------------------------------- columns -- */

/*
 * Row (and select-all) checkboxes stay out of the way until the row is
 * hovered / focused, or while any row is selected (see the table container
 * class).
 */
const checkboxClass =
  "row-checkbox opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=checked]:opacity-100";

const SELECT_WIDTH = 36;

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

const selectColumn: ColumnDef<TData, any> = {
  id: "select",
  size: SELECT_WIDTH,
  enableHiding: false,
  enableSorting: false,
  enableGlobalFilter: false,
  // Only (de)selects the rows that pass the current filter.
  header: () =>
    h(Checkbox, {
      class: checkboxClass,
      "aria-label": "Select all",
      checked: allFilteredSelected.value
        ? true
        : selectedRows.value.length > 0
          ? "indeterminate"
          : false,
      "onUpdate:checked": (checked: boolean | "indeterminate") =>
        selectAllFiltered(checked === true),
    }),
  cell: ({ row }) =>
    h(Checkbox, {
      class: checkboxClass,
      "aria-label": "Select row",
      checked: row.getIsSelected(),
      "onUpdate:checked": row.getToggleSelectedHandler(),
      onClick: (e: Event) => e.stopPropagation(),
    }),
};

/*
 * Printer columns (row.__printerColumns, see tables/printerColumns.ts) for
 * kinds without their own column definitions. Same array identity while the
 * set of columns is unchanged, so refreshes don't rebuild the table columns.
 */
const headerName = (column: ColumnDef<TData, any>) =>
  typeof column.header === "string"
    ? column.header
    : (column as { id?: string }).id || "";

let printerCache: { signature: string; defs: ColumnDef<TData, any>[] } = {
  signature: "",
  defs: [],
};
const printerColumns = computed(() => {
  const collected = collectPrinterColumns(props.data);
  if (collected.length === 0) {
    printerCache = { signature: "", defs: [] };
    return printerCache.defs;
  }
  const headers = props.columns.map(headerName);
  const signature = `${printerColumnsSignature(collected)}#${headers.join(
    "\u0000"
  )}`;
  if (signature !== printerCache.signature) {
    printerCache = {
      signature,
      defs: printerColumnDefs(collected, headers) as ColumnDef<TData, any>[],
    };
  }
  return printerCache.defs;
});

const allColumns = computed<ColumnDef<TData, any>[]>(() => {
  const own = props.columns as ColumnDef<TData, any>[];
  let middle = own;
  if (printerColumns.value.length > 0) {
    // printer columns go before a trailing Age column
    const ageIndex = own.findIndex(
      (column) => (column as { id?: string }).id === "Age"
    );
    const at = ageIndex < 0 ? own.length : ageIndex;
    middle = [...own.slice(0, at), ...printerColumns.value, ...own.slice(at)];
  }
  return [
    selectColumn,
    ...middle,
    ...(props.rowActions?.length ? [actionsColumn] : []),
  ];
});

/* ------------------------------------------------------------ model -- */

const { table, filteredRows, sortedRows, selectedRows } = useTableModel<TData>({
  data: () => props.data,
  columns: () => allColumns.value,
  query: () => searchQuery.value,
  sorting,
  onSortingChange: (value) => emit("sortingChange", value),
  initialVisibility: props.visibleColumns,
});

const allFilteredSelected = computed(
  () =>
    filteredRows.value.length > 0 &&
    selectedRows.value.length === filteredRows.value.length
);

const selectAllFiltered = (select: boolean) => {
  if (!select) {
    table.resetRowSelection();
    return;
  }
  const selection: RowSelectionState = { ...table.getState().rowSelection };
  for (const row of filteredRows.value) selection[row.id] = true;
  table.setRowSelection(selection);
};

/* Column order: persisted order, pinned select / actions columns. */
/* Column ids in definition order (independent of the column order state). */
const columnIdsKey = computed(() =>
  table
    .getAllFlatColumns()
    .map((column) => column.id)
    .join("\u0000")
);
const leafColumnIds = computed(() => columnIdsKey.value.split("\u0000"));
watch(
  [columnIdsKey, () => prefs.value.order],
  () => {
    const next = resolveColumnOrder(leafColumnIds.value, prefs.value.order);
    const current = table.getState().columnOrder || [];
    if (next.join("\u0000") !== current.join("\u0000")) {
      table.setColumnOrder(next);
    }
  },
  { immediate: true }
);

const { contexts } = injectStrict(KubeContextStateKey);

/* Cluster-scoped kinds (nodes, persistent volumes, ...) have no namespace. */
const hasNamespacedRows = computed(
  () =>
    props.data.length === 0 ||
    props.data.some(
      (row) =>
        !!(row as { metadata?: { namespace?: string } })?.metadata?.namespace
    )
);

/*
 * Column visibility, in order of precedence:
 * 1. the user's explicit choice (persisted per kind)
 * 2. multi-context columns (meta flags):
 *    - multiple contexts  -> show both Context and Namespace columns
 *    - single context     -> Namespace only when multiple namespaces are
 *      active or "all namespaces" is selected
 * 3. `defaultHidden` columns (e.g. priority > 0 printer columns)
 * Other columns keep their current state (`visibleColumns` prop).
 */
const applyColumnVisibility = () => {
  const isMultiContext = contexts.value.size > 1;
  let isMultiNamespace = isMultiContext;
  if (contexts.value.size === 1) {
    const firstContext = contexts.value.values().next().value;
    if (firstContext) {
      isMultiNamespace = firstContext.length > 1 || firstContext[0] === "all";
    }
  }

  const user = prefs.value.visibility || {};
  const visibility: Record<string, boolean> = {};
  for (const column of table.getAllLeafColumns()) {
    const meta = column.columnDef.meta;
    if (column.id in user && column.getCanHide()) {
      visibility[column.id] = user[column.id];
    } else if (meta?.showOnMultipleNamespaces) {
      visibility[column.id] =
        (isMultiContext || isMultiNamespace) && hasNamespacedRows.value;
    } else if (meta?.showOnMultipleClusters) {
      visibility[column.id] = isMultiContext;
    } else if (meta?.defaultHidden) {
      visibility[column.id] = false;
    }
  }

  table.setColumnVisibility((current) => ({ ...current, ...visibility }));
};

watch(contexts, applyColumnVisibility, { immediate: true, deep: true });
// Only fires when the data switches between namespaced / cluster-scoped.
watch(hasNamespacedRows, applyColumnVisibility);
watch(columnIdsKey, applyColumnVisibility);
watch(() => prefs.value.visibility, applyColumnVisibility);

const setUserVisibility = (
  column: Column<TData, unknown>,
  visible: boolean
) => {
  updatePrefs({
    visibility: { ...(prefs.value.visibility || {}), [column.id]: visible },
  });
};

const resetColumns = () => {
  updatePrefs({ order: undefined, sizes: undefined, visibility: undefined });
  // re-derive automatic visibility for columns the user had overridden
  table.setColumnVisibility(props.visibleColumns || {});
  applyColumnVisibility();
};

const hasColumnPrefs = computed(
  () =>
    !!(
      prefs.value.order?.length ||
      Object.keys(prefs.value.sizes || {}).length ||
      Object.keys(prefs.value.visibility || {}).length
    )
);

const visibleLeafColumns = computed(() => table.getVisibleLeafColumns());
const visibleColumnCount = computed(() => visibleLeafColumns.value.length || 1);

const hideableColumns = computed(() =>
  table.getAllLeafColumns().filter((column) => column.getCanHide())
);

const columnLabel = (column: {
  id: string;
  columnDef: ColumnDef<TData, any>;
}) =>
  typeof column.columnDef.header === "string"
    ? column.columnDef.header
    : column.id;

/* The object name column carries the row: medium weight, full contrast. */
const PRIMARY_COLUMN_IDS = new Set(["metadata_name", "name", "Name"]);

const isPinnedColumn = (id: string) => id === "select" || id === "actions";

/* Width of a column: user size, else its definition size, else auto. */
const columnWidth = (column: Column<TData, unknown>): number | undefined => {
  if (column.id === "select") return SELECT_WIDTH;
  const user = prefs.value.sizes?.[column.id];
  if (user) return user;
  const size = column.columnDef.size;
  return size !== undefined && size !== Number.MAX_SAFE_INTEGER
    ? size
    : undefined;
};

/*
 * The name column (else the first data column) sticks to the left edge,
 * next to the selection column, on horizontal scroll.
 */
const stickyColumnId = computed(
  () =>
    (
      visibleLeafColumns.value.find((column) =>
        PRIMARY_COLUMN_IDS.has(column.id)
      ) ?? visibleLeafColumns.value.find((column) => column.id !== "select")
    )?.id
);

const headerStyle = (column: Column<TData, unknown>) => {
  const width = columnWidth(column);
  const style: Record<string, string> = {};
  if (width !== undefined) {
    style.width = `${width}px`;
    if (prefs.value.sizes?.[column.id] || column.id === "select") {
      style.minWidth = `${width}px`;
      style.maxWidth = `${width}px`;
    }
  }
  if (column.id === stickyColumnId.value) {
    style.left = `${SELECT_WIDTH}px`;
  }
  return style;
};

/* Content box of a sized cell (the td has 2 × 10px padding). */
const contentStyle = (column: Column<TData, unknown>) => {
  if (isPinnedColumn(column.id)) return undefined;
  const user = prefs.value.sizes?.[column.id];
  if (user) return { width: `calc(${user}px - 1.25rem)` };
  const width = columnWidth(column);
  return width !== undefined
    ? { maxWidth: `calc(${width}px - 1.25rem)` }
    : undefined;
};

const isNumericColumn = (column: Column<TData, unknown>) =>
  !!column.columnDef.meta?.numeric;

const cellClass = (column: Column<TData, unknown>, row: Row<TData>) => [
  "px-2.5 py-0 align-middle",
  column.columnDef.meta?.class?.(row.original),
  column.columnDef.meta?.numeric ? "text-right tabular-nums" : "",
  column.id === "select" ? "pl-3 pr-0 vdt-sticky vdt-sticky-select" : "",
  column.id === "actions" ? "px-1.5 text-right" : "",
  column.id === stickyColumnId.value ? "vdt-sticky vdt-sticky-edge" : "",
  PRIMARY_COLUMN_IDS.has(column.id) ? "font-medium text-foreground" : "",
];

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

/* -------------------------------------------------- reorder / resize -- */

const dragState = reactive({
  id: null as string | null,
  pointerId: -1,
  startX: 0,
  active: false,
  beforeId: null as string | null,
  indicatorLeft: 0,
});
let headerRects: { id: string; left: number; right: number }[] = [];
let suppressHeaderClick = false;

const resizeState = reactive({
  id: null as string | null,
  startX: 0,
  startWidth: 0,
});

const onHeaderPointerDown = (event: PointerEvent, columnId: string) => {
  if (event.button !== 0 || isPinnedColumn(columnId) || resizeState.id) return;
  if ((event.target as HTMLElement).closest(".vdt-resizer, [role=checkbox]")) {
    return;
  }
  dragState.id = columnId;
  dragState.pointerId = event.pointerId;
  dragState.startX = event.clientX;
  dragState.active = false;
};

const onHeaderPointerMove = (event: PointerEvent) => {
  if (!dragState.id || event.pointerId !== dragState.pointerId) return;

  if (!dragState.active) {
    if (Math.abs(event.clientX - dragState.startX) < 5) return;
    dragState.active = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    headerRects = Array.from(
      tableContainer.value?.querySelectorAll<HTMLElement>(
        "thead th[data-column-id]"
      ) || []
    )
      .filter((th) => !isPinnedColumn(th.dataset.columnId || ""))
      .map((th) => {
        const rect = th.getBoundingClientRect();
        return {
          id: th.dataset.columnId || "",
          left: rect.left,
          right: rect.right,
        };
      });
  }

  const container = tableContainer.value;
  if (!container || headerRects.length === 0) return;
  const containerLeft = container.getBoundingClientRect().left;

  const target = headerRects.find(
    (rect) => event.clientX < (rect.left + rect.right) / 2
  );
  dragState.beforeId = target?.id ?? null;
  const edge = target ? target.left : headerRects[headerRects.length - 1].right;
  dragState.indicatorLeft = edge - containerLeft + container.scrollLeft - 1;
};

const endHeaderDrag = () => {
  if (dragState.active && dragState.id) {
    const current = table.getState().columnOrder?.length
      ? table.getState().columnOrder
      : leafColumnIds.value;
    const next = moveColumn(current, dragState.id, dragState.beforeId);
    updatePrefs({ order: next.filter((id) => !isPinnedColumn(id)) });
    suppressHeaderClick = true;
    setTimeout(() => (suppressHeaderClick = false), 0);
  }
  dragState.id = null;
  dragState.active = false;
  dragState.pointerId = -1;
};

const onHeaderClick = (event: MouseEvent, header: Header<TData, unknown>) => {
  if (suppressHeaderClick) return;
  header.column.getToggleSortingHandler()?.(event);
};

const onResizePointerDown = (event: PointerEvent, columnId: string) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const th = (event.target as HTMLElement).closest("th");
  resizeState.id = columnId;
  resizeState.startX = event.clientX;
  resizeState.startWidth = th?.getBoundingClientRect().width || 120;
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
};

const onResizePointerMove = (event: PointerEvent) => {
  if (!resizeState.id) return;
  const width = clampWidth(
    resizeState.startWidth + event.clientX - resizeState.startX
  );
  updatePrefs({
    sizes: { ...(prefs.value.sizes || {}), [resizeState.id]: width },
  });
};

const onResizePointerUp = () => {
  if (!resizeState.id) return;
  resizeState.id = null;
  suppressHeaderClick = true;
  setTimeout(() => (suppressHeaderClick = false), 0);
};

const resetColumnWidth = (columnId: string) => {
  const sizes = { ...(prefs.value.sizes || {}) };
  delete sizes[columnId];
  updatePrefs({ sizes });
};

/* --------------------------------------------------------- grouping -- */

const groupOptions = computed(() =>
  props.allowFilter ? availableGroupOptions(props.data) : []
);
const activeGroup = computed(() => {
  const option = groupOption(prefs.value.groupBy);
  return option && groupOptions.value.some((o) => o.id === option.id)
    ? option
    : null;
});
const collapsedGroups = ref(new Set<string>());

const setGroupBy = (id: string) => {
  collapsedGroups.value = new Set();
  updatePrefs({ groupBy: id === "none" ? null : id });
};

const toggleGroup = (key: string, collapse?: boolean) => {
  const next = new Set(collapsedGroups.value);
  const shouldCollapse = collapse ?? !next.has(key);
  if (shouldCollapse) next.add(key);
  else next.delete(key);
  collapsedGroups.value = next;
};

const displayItems = computed<DisplayItem<Row<TData>>[]>(() =>
  buildDisplayItems(
    filteredRows.value,
    activeGroup.value,
    collapsedGroups.value
  )
);

const groupKeys = computed(() =>
  displayItems.value.flatMap((item) =>
    item.type === "group" ? [item.key] : []
  )
);

const setAllGroupsCollapsed = (collapse: boolean) => {
  collapsedGroups.value = collapse ? new Set(groupKeys.value) : new Set();
};

/* ---------------------------------------------------- virtualisation -- */

const isFiltering = computed(() => searchQuery.value.length > 0);
const clearFilter = () => {
  searchQuery.value = "";
};

const emptyResourceName = computed(() => props.resourceName || "results");
const lastUpdatedLabel = computed(() =>
  props.lastUpdated ? formatAge(props.lastUpdated) : null
);

/* Dense rows (~34px); views with taller cells pass their own height. */
const rowHeight = computed(() => props.estimatedRowHeight || 34);
const HEADER_HEIGHT = 32;

const skeletonWidths = ["w-3/4", "w-1/2", "w-2/3", "w-5/12"];

const virtualizerOptions = computed(() => ({
  count: displayItems.value.length,
  getScrollElement: () => tableContainer.value,
  estimateSize: () => rowHeight.value,
  overscan: 12,
  scrollMargin: HEADER_HEIGHT,
  scrollPaddingStart: props.stickyHeaders ? HEADER_HEIGHT : 0,
  getItemKey: (index: number) => displayItems.value[index]?.id ?? index,
}));

const virtualizer = useVirtualizer(virtualizerOptions);
const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

const visibleItems = computed(() =>
  virtualRows.value
    .map((virtualRow) => displayItems.value[virtualRow.index])
    .filter((item): item is DisplayItem<Row<TData>> => !!item)
);

const before = computed(() =>
  virtualRows.value.length > 0
    ? Math.max(0, virtualRows.value[0].start - HEADER_HEIGHT)
    : 0
);

const after = computed(() =>
  virtualRows.value.length > 0
    ? Math.max(
        0,
        totalSize.value -
          (virtualRows.value[virtualRows.value.length - 1].end - HEADER_HEIGHT)
      )
    : 0
);

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

/* Horizontal scroll: shadow under the sticky first column. */
const scrolledX = ref(false);
const onContainerScroll = () => {
  const scrolled = (tableContainer.value?.scrollLeft || 0) > 0;
  if (scrolled !== scrolledX.value) scrolledX.value = scrolled;
};

/* Relative ages re-render every few seconds even when rows are unchanged. */
const clock = ref(0);
let clockTimer: ReturnType<typeof setInterval> | undefined;

/* -------------------------------------------------- row rendering -- */

const getRowClasses = (row: TData) =>
  typeof props.rowClasses === "function"
    ? props.rowClasses(row)
    : props.rowClasses || "";

/* Changes whenever the column layout changes (memoised rows re-render). */
const layoutKey = computed(
  () =>
    `${visibleLeafColumns.value
      .map((column) => `${column.id}:${prefs.value.sizes?.[column.id] ?? ""}`)
      .join(",")}|${stickyColumnId.value}`
);
let columnsVersion = 0;
watch(allColumns, () => columnsVersion++);

/* -------------------------------------------------- keyboard cursor -- */

const cursorId = ref<string | null>(null);
const cursorVisible = ref(false);
let cursorIndexHint = 0;
let selectionAnchor: { index: number; base: RowSelectionState } | null = null;

const keyboardEnabled = computed(() =>
  props.keyboard !== undefined
    ? props.keyboard
    : !!props.allowFilter &&
      (!!props.rowActions?.length || hasRowClickListener.value)
);

const shortcutsOpen = ref(false);

/*
 * Row navigation mode: the row cursor is shown and letters are commands.
 * Otherwise (default) letters type into the filter.
 */
const navigating = computed(() => keyboardEnabled.value && cursorVisible.value);

/* Memo deps of a rendered row: only these changing re-renders it. */
const memoDeps = (item: DisplayItem<Row<TData>>) =>
  item.type === "group"
    ? [
        "g",
        item.label,
        item.count,
        item.collapsed,
        cursorVisible.value && cursorId.value === item.id,
        visibleColumnCount.value,
        groupSelectionState(item.key),
      ]
    : [
        item.row.original,
        item.row.getIsSelected(),
        cursorVisible.value && cursorId.value === item.id,
        layoutKey.value,
        clock.value,
        columnsVersion,
        getRowClasses(item.row.original),
        hasRowClickListener.value,
      ];

/* Rows per group key and their selection state (only while grouped). */
const groupRows = computed(() => {
  const group = activeGroup.value;
  const map = new Map<string, Row<TData>[]>();
  if (!group) return map;
  for (const row of filteredRows.value) {
    const key = group.get(row.original) || "";
    let rows = map.get(key);
    if (!rows) map.set(key, (rows = []));
    rows.push(row);
  }
  return map;
});

const groupSelectionStates = computed(() => {
  const states = new Map<string, boolean | "indeterminate">();
  const selection = table.getState().rowSelection;
  for (const [key, rows] of groupRows.value) {
    const selected = rows.filter((row) => selection[row.id]).length;
    states.set(
      key,
      selected === 0 ? false : selected === rows.length ? true : "indeterminate"
    );
  }
  return states;
});

const groupSelectionState = (key: string) =>
  groupSelectionStates.value.get(key) ?? false;

const rowsOfGroup = (key: string) => groupRows.value.get(key) || [];

const toggleGroupSelection = (key: string) => {
  const rows = rowsOfGroup(key);
  const select = groupSelectionState(key) !== true;
  const selection: RowSelectionState = { ...table.getState().rowSelection };
  for (const row of rows) {
    if (select) selection[row.id] = true;
    else delete selection[row.id];
  }
  table.setRowSelection(selection);
};

const itemIndex = (id: string | null) =>
  id === null ? -1 : displayItems.value.findIndex((item) => item.id === id);

const cursorItem = computed(() => {
  if (!cursorId.value) return null;
  const index = itemIndex(cursorId.value);
  return index >= 0 ? displayItems.value[index] : null;
});

const pageSize = () =>
  Math.max(
    1,
    Math.floor(
      ((tableContainer.value?.clientHeight || 400) - HEADER_HEIGHT) /
        rowHeight.value
    ) - 1
  );

const setCursor = (index: number, scroll = true) => {
  const items = displayItems.value;
  const clamped = clampIndex(index, items.length);
  if (clamped < 0) {
    cursorId.value = null;
    return;
  }
  cursorId.value = items[clamped].id;
  cursorIndexHint = clamped;
  cursorVisible.value = true;
  if (scroll) {
    virtualizer.value.scrollToIndex(clamped, { align: "auto" });
  }
};

/* Index of the cursor; a vanished row falls back to its last position. */
const currentCursorIndex = () => {
  const index = itemIndex(cursorId.value);
  return index >= 0
    ? index
    : clampIndex(cursorIndexHint, displayItems.value.length);
};

const moveCursor = (target: (current: number) => number, extend: boolean) => {
  const items = displayItems.value;
  if (items.length === 0) return;

  const hasCursor = cursorId.value !== null && cursorVisible.value;
  const current = hasCursor ? currentCursorIndex() : -1;
  const next = hasCursor ? target(current) : target(-1) < 0 ? 0 : target(-1);

  if (extend) {
    if (!selectionAnchor) {
      selectionAnchor = {
        index: Math.max(current, 0),
        base: { ...table.getState().rowSelection },
      };
    }
    setCursor(next);
    const range = rangeIds(
      items.filter((item) => item.type === "row") as { id: string }[],
      rowOrdinal(selectionAnchor.index),
      rowOrdinal(clampIndex(next, items.length))
    );
    const selection: RowSelectionState = { ...selectionAnchor.base };
    for (const id of range) selection[id] = true;
    table.setRowSelection(selection);
  } else {
    selectionAnchor = null;
    setCursor(next);
  }
};

/* Position of an item among the row items (group headers skipped). */
const rowOrdinal = (index: number) => {
  let ordinal = -1;
  const items = displayItems.value;
  for (let i = 0; i <= index && i < items.length; i++) {
    if (items[i].type === "row") ordinal++;
  }
  return Math.max(ordinal, 0);
};

const cursorRow = (): Row<TData> | null => {
  const item = cursorVisible.value ? cursorItem.value : null;
  return item?.type === "row" ? item.row : null;
};

const rowElement = (id: string) =>
  tableContainer.value?.querySelector<HTMLElement>(
    `tr[data-item-id="${CSS.escape(id)}"]`
  ) || null;

/* Quick pick for actions with options (Logs / Shell per container). */
const picker = shallowRef<{
  title: string;
  options: WithHandler<TData>[];
  labels: { label: string }[];
  anchor: { x: number; y: number };
} | null>(null);

const closePicker = () => {
  picker.value = null;
  nextTick(() => tableContainer.value?.focus({ preventScroll: true }));
};

const runPickerOption = (index: number) => {
  const option = picker.value?.options[index];
  closePicker();
  option?.handler(contextMenuSubject.value as TData);
};

const runAction = (id: ActionId) => {
  // Delete applies to the selection when there is one.
  if (id === "delete" && selectedRows.value.length > 0) {
    const sample = selectedRows.value[0].original;
    const action = findRowAction(props.rowActions, "delete", sample);
    if (action && "massAction" in action && action.massAction) {
      action.handler(selectedRows.value.map((row) => row.original));
      table.resetRowSelection();
      return;
    }
  }

  const row = cursorRow();
  if (!row) return;
  const subject = row.original;

  if (id === "details" && hasRowClickListener.value) {
    emit("rowClicked", subject);
    return;
  }

  const action = findRowAction(props.rowActions, id, subject);
  if (!action) {
    if (props.rowActions?.length) {
      toast({
        title: `No ${id === "edit" ? "edit" : id} action for ${emptyResourceName.value}`,
      });
    }
    return;
  }

  setContextMenuSubject(subject);
  if ("options" in action && action.options) {
    const options = action.options(subject);
    if (options.length === 0) {
      toast({
        title: `Nothing to ${rowActionLabel(action, subject).toLowerCase()}`,
      });
      return;
    }
    if (options.length === 1) {
      options[0].handler(subject);
      return;
    }
    const rect = rowElement(row.id)?.getBoundingClientRect();
    picker.value = {
      title: `${rowActionLabel(action, subject)} · ${rowName(subject)}`,
      options,
      labels: options.map((option) => ({
        label: rowActionLabel(option, subject),
      })),
      anchor: {
        x: (rect?.left ?? 200) + SELECT_WIDTH + 8,
        y: rect?.bottom ?? 200,
      },
    };
    return;
  }

  if ("massAction" in action && action.massAction) {
    action.handler([subject]);
    return;
  }
  (action as WithHandler<TData>).handler(subject);
};

const rowName = (row: TData): string => {
  const r = row as { metadata?: { name?: string }; name?: string };
  return r?.metadata?.name ?? r?.name ?? "";
};

const copyName = async (row: TData | null) => {
  const name = row ? rowName(row) : "";
  if (!name) return;
  try {
    await writeText(name);
  } catch {
    try {
      await navigator.clipboard?.writeText(name);
    } catch {
      toast({
        title: "Couldn't copy to the clipboard",
        variant: "destructive",
      });
      return;
    }
  }
  toast({ title: "Copied name", description: name });
};

const focusFilter = () => {
  searchInput.value?.focus();
  searchInput.value?.select();
};

/* Esc steps back one layer: selection, then row mode, then the filter. */
const handleEscape = (): boolean => {
  if (selectedRows.value.length > 0) {
    table.resetRowSelection();
    selectionAnchor = null;
    return true;
  }
  if (cursorVisible.value) {
    cursorVisible.value = false;
    return true;
  }
  if (searchQuery.value) {
    clearFilter();
    return true;
  }
  return false;
};

const runCommand = (command: TableCommand): boolean => {
  const count = displayItems.value.length;
  switch (command.type) {
    case "move":
      moveCursor((current) => current + command.delta, command.extend);
      return true;
    case "page":
      moveCursor(
        (current) => Math.max(current, 0) + command.direction * pageSize(),
        command.extend
      );
      return true;
    case "home":
      moveCursor(() => 0, command.extend);
      return true;
    case "end":
      moveCursor(() => count - 1, command.extend);
      return true;
    case "open": {
      const item = cursorVisible.value ? cursorItem.value : null;
      if (!item) return false;
      if (item.type === "group") toggleGroup(item.key);
      else runAction("details");
      return true;
    }
    case "action":
      runAction(command.action);
      return true;
    case "copyName":
      copyName(cursorRow()?.original ?? null);
      return true;
    case "toggleSelect": {
      const item = cursorVisible.value ? cursorItem.value : null;
      if (!item) return false;
      if (item.type === "group") toggleGroupSelection(item.key);
      else item.row.toggleSelected();
      selectionAnchor = null;
      return true;
    }
    case "focusFilter":
      if (!props.allowFilter) return false;
      focusFilter();
      return true;
    case "escape":
      return handleEscape();
    case "help":
      shortcutsOpen.value = true;
      return true;
    case "collapse":
    case "expand": {
      const item = cursorVisible.value ? cursorItem.value : null;
      if (!item || !activeGroup.value) return false;
      if (item.type === "group") {
        toggleGroup(item.key, command.type === "collapse");
      } else if (command.type === "collapse") {
        const key = activeGroup.value.get(item.row.original) || "";
        toggleGroup(key, true);
        cursorId.value = `group:${key}`;
        nextTick(() => setCursor(currentCursorIndex()));
      }
      return true;
    }
  }
};

/* Hidden (e.g. kept-alive or display:none) tables never take keys. */
let isActive = true;
const isTableVisible = () =>
  isActive && !!root.value?.isConnected && root.value.offsetParent !== null;

/*
 * Window-level keys:
 * - keyboard tables: the k9s-style commands (see tables/keyboard.ts). The
 *   letter commands only apply in row navigation mode (the row cursor is
 *   shown: arrows / PgUp / PgDn / Home / End, a row click, Enter or ↓ from
 *   the filter); otherwise letters filter.
 * - filterable tables: Cmd/Ctrl+F and `/` focus the filter; any other
 *   letter / digit starts type-to-filter (and leaves row mode). Keys pressed
 *   in fields, editors, terminals and open overlays are left alone, and so
 *   are keys while text is selected (copying from e.g. the describe drawer
 *   keeps working, #69) and keys pressed in the details side panel.
 */
const handleWindowKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (!props.allowFilter && !keyboardEnabled.value) return;
  if (shortcutsOpen.value || picker.value) return;
  if (!isTableVisible()) return;

  const target = event.target;
  if (target === searchInput.value) return;
  if (isEditableTarget(target) || isInOverlay(target)) return;
  // e.g. the details side panel: its keys are not table commands
  if (isInKeyboardScope(target) && !root.value?.contains(target as Node)) {
    return;
  }

  const command = resolveTableKey(event, isMac, navigating.value);
  if (command && (keyboardEnabled.value || command.type === "focusFilter")) {
    if (
      (command.type === "open" || command.type === "toggleSelect") &&
      isActivatable(target)
    ) {
      return;
    }
    // with text selected (e.g. in the details panel) `y` must not shadow a copy
    if (command.type === "copyName" && window.getSelection()?.toString()) {
      return;
    }
    if (runCommand(command)) {
      event.preventDefault();
    }
    return;
  }

  // type-to-filter
  if (!props.allowFilter) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.length !== 1 || !/[a-z0-9]/i.test(event.key)) return;
  if (window.getSelection()?.toString()) return;
  searchInput.value?.focus();
};

/* Typing into the filter leaves row navigation mode. */
const handleSearchInput = () => {
  cursorVisible.value = false;
  selectionAnchor = null;
};

const handleSearchInputKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    searchQuery.value = "";
    searchInput.value?.blur();
    return;
  }
  // Enter / ↓: jump from the filter to the first match.
  if (
    keyboardEnabled.value &&
    (event.key === "Enter" || event.key === "ArrowDown") &&
    displayItems.value.length > 0
  ) {
    event.preventDefault();
    searchInput.value?.blur();
    tableContainer.value?.focus({ preventScroll: true });
    setCursor(0);
  }
};

/* ------------------------------------------------- pointer handlers -- */

const itemById = (id: string | undefined) =>
  id ? (displayItems.value.find((item) => item.id === id) ?? null) : null;

const itemFromEvent = (event: Event) => {
  const tr = (event.target as HTMLElement).closest<HTMLElement>(
    "tr[data-item-id]"
  );
  return itemById(tr?.dataset.itemId);
};

const onBodyClick = (event: MouseEvent) => {
  const item = itemFromEvent(event);
  if (!item) return;
  if (item.type === "group") {
    if ((event.target as HTMLElement).closest("[role=checkbox]")) return;
    toggleGroup(item.key);
    cursorId.value = item.id;
    return;
  }
  cursorId.value = item.id;
  cursorIndexHint = itemIndex(item.id);
  cursorVisible.value = keyboardEnabled.value;
  selectionAnchor = null;
  emit("rowClicked", item.row.original);
};

const onBodyContextMenu = (event: MouseEvent) => {
  const item = itemFromEvent(event);
  if (item?.type === "row") {
    setContextMenuSubject(item.row.original);
    cursorId.value = item.id;
    cursorVisible.value = keyboardEnabled.value;
  }
};

/* ----------------------------------------------------- row actions -- */

/* Label of a row action; function labels depend on the menu subject. */
const actionLabel = (rowAction: RowAction<TData>): string =>
  rowActionLabel(
    rowAction,
    (contextMenuSubject.value as TData | null) ??
      selectedRows.value[0]?.original ??
      null
  );

const actionShortcut = (rowAction: RowAction<TData>) => {
  if (!keyboardEnabled.value) return null;
  const id = actionIdForLabel(actionLabel(rowAction));
  if (!id || (id === "details" && hasRowClickListener.value)) return null;
  // only the action a shortcut actually resolves to gets the hint
  const subject = contextMenuSubject.value as TData | null;
  if (subject && findRowAction(props.rowActions, id, subject) !== rowAction) {
    return null;
  }
  return actionKeys(id, isMac);
};

const handleRowAction = (
  rowAction: WithHandler<TData> | MassWithHandler<TData>,
  fromContextMenu = false
) => {
  const subject = contextMenuSubject.value as TData;

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

/*
 * Guardrails: actions that would change a read-only cluster are left out of
 * the row menu and disabled (with the reason) in the selection bar. Their
 * handlers block them too (keyboard shortcuts).
 */
const resolveCluster = (ref: ClusterRef) =>
  guardedCluster(ref.context, ref.kubeConfig);

const isRowActionBlocked = (rowAction: RowAction<TData>) => {
  const subject = contextMenuSubject.value as TData | null;
  return !!subject && blockedReason(rowAction, [subject], resolveCluster) !== null;
};

const isRowActionAvailable = (rowAction: RowAction<TData>) =>
  !isRowActionBlocked(rowAction) &&
  ("isAvailable" in rowAction && rowAction.isAvailable
    ? rowAction.isAvailable(contextMenuSubject.value as TData)
    : true);

const massActions = computed(() =>
  (props.rowActions || []).filter(
    (rowAction): rowAction is MassWithHandler<TData> =>
      "massAction" in rowAction && rowAction.massAction === true
  )
);

/* Why a mass action is disabled for the selection (read-only clusters). */
const massActionBlocks = computed(() => {
  const rows = selectedRows.value.map((row) => row.original);
  return new Map(
    massActions.value.map((rowAction) => [
      rowAction,
      rows.length ? blockedReason(rowAction, rows, resolveCluster) : null,
    ])
  );
});

/* -------------------------------------------------------- lifecycle -- */

const listen = () => window.addEventListener("keydown", handleWindowKeyDown);
const unlisten = () =>
  window.removeEventListener("keydown", handleWindowKeyDown);

/* Hidden (kept-alive) tables don't tick; ages catch up on activation. */
const startClock = () => {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => clock.value++, 5000);
};

onMounted(() => {
  listen();
  startClock();
});

onActivated(() => {
  isActive = true;
  listen();
  if (clockTimer === undefined) {
    clock.value++;
    startClock();
  }
});

onDeactivated(() => {
  isActive = false;
  unlisten();
  clearInterval(clockTimer);
  clockTimer = undefined;
});

onBeforeUnmount(() => {
  unlisten();
  clearInterval(clockTimer);
  clearTimeout(saveTimer);
  if (prefsKind.value) saveTablePrefs(prefsKind.value, prefs.value);
});

const searchPlaceholder = computed(() => `Filter ${emptyResourceName.value}…`);
</script>

<template>
  <div
    ref="root"
    class="relative flex h-full flex-col"
    :class="{ 'vdt-scrolled-x': scrolledX }"
  >
    <!-- Toolbar: filter, count, grouping, columns and view actions -->
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
          :aria-keyshortcuts="isMac ? 'Meta+F /' : 'Control+F /'"
          class="h-7 w-full rounded-md border border-transparent bg-muted/60 pl-8 pr-16 text-sm text-foreground transition-[border-color,box-shadow,background-color] duration-fast ease-out placeholder:text-muted-foreground hover:bg-muted focus:border-ring focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/20"
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @keydown="handleSearchInputKeydown"
          @input="handleSearchInput"
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
          <Kbd v-else-if="keyboardEnabled" size="sm">/</Kbd>
          <Kbd v-else :keys="isMac ? ['⌘', 'F'] : ['Ctrl', 'F']" size="sm" />
        </div>
      </div>
      <span
        class="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        <template v-if="isFiltering">
          <span class="font-medium text-foreground">{{
            filteredRows.length
          }}</span>
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
        <!-- View: grouping, columns and the keyboard reference in one menu -->
        <DropdownMenu
          v-if="
            groupOptions.length > 0 ||
            hideableColumns.length > 0 ||
            keyboardEnabled
          "
        >
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              :class="activeGroup ? 'text-foreground' : 'text-muted-foreground'"
              :aria-label="
                activeGroup
                  ? `View options, grouped by ${activeGroup.label.toLowerCase()}`
                  : 'View options'
              "
              title="Grouping, columns and shortcuts"
            >
              <SlidersHorizontal class="h-3.5 w-3.5" />
              {{
                activeGroup ? `By ${activeGroup.label.toLowerCase()}` : "View"
              }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <template v-if="groupOptions.length > 0">
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                :model-value="activeGroup?.id ?? 'none'"
                @update:model-value="setGroupBy"
              >
                <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  v-for="option in groupOptions"
                  :key="option.id"
                  :value="option.id"
                >
                  {{ option.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <template v-if="activeGroup">
                <DropdownMenuSeparator />
                <DropdownMenuItem @select="setAllGroupsCollapsed(true)">
                  Collapse all groups
                </DropdownMenuItem>
                <DropdownMenuItem @select="setAllGroupsCollapsed(false)">
                  Expand all groups
                </DropdownMenuItem>
              </template>
              <DropdownMenuSeparator />
            </template>
            <DropdownMenuSub v-if="hideableColumns.length > 0">
              <DropdownMenuSubTrigger>
                <Columns3 class="h-3.5 w-3.5 text-muted-foreground" />
                Columns
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-56">
                <DropdownMenuCheckboxItem
                  v-for="column in hideableColumns"
                  :key="column.id"
                  :checked="column.getIsVisible()"
                  @select="(event: Event) => event.preventDefault()"
                  @update:checked="
                    (checked: boolean) => setUserVisibility(column, checked)
                  "
                >
                  {{ columnLabel(column) }}
                </DropdownMenuCheckboxItem>
                <template v-if="prefsKind">
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    :disabled="!hasColumnPrefs"
                    @select="resetColumns"
                  >
                    <RotateCcw class="h-3.5 w-3.5 text-muted-foreground" />
                    Reset columns
                  </DropdownMenuItem>
                  <p
                    class="px-2 pb-1 pt-1.5 text-xs text-muted-foreground"
                  >
                    Drag a header to reorder, its edge to resize.
                  </p>
                </template>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              v-if="keyboardEnabled"
              aria-keyshortcuts="?"
              @select="shortcutsOpen = true"
            >
              <Keyboard class="h-3.5 w-3.5 text-muted-foreground" />
              Keyboard shortcuts
              <DropdownMenuShortcut>?</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <slot name="action-buttons" />
      </div>
    </div>

    <!-- Load error banner (an empty table shows the error in its place) -->
    <div
      v-if="error && !(error.fatal && data.length === 0)"
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
      class="vdt-container relative min-h-0 flex-1 overflow-auto outline-none"
      :class="{ '[&_.row-checkbox]:opacity-100': selectedRows.length > 0 }"
      :tabindex="keyboardEnabled ? 0 : undefined"
      :aria-label="
        keyboardEnabled
          ? `${emptyResourceName} table. Press ? for keyboard shortcuts.`
          : undefined
      "
      @scroll.passive="onContainerScroll"
    >
      <table class="w-full caption-bottom text-sm">
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <thead>
              <tr
                v-for="headerGroup in table.getHeaderGroups()"
                :key="headerGroup.id"
                class="group/row border-b-0"
              >
                <th
                  v-for="header in headerGroup.headers"
                  :key="header.id"
                  :data-column-id="header.column.id"
                  :style="headerStyle(header.column)"
                  :title="header.column.columnDef.meta?.headerTitle"
                  :aria-sort="
                    header.column.getIsSorted() === 'asc'
                      ? 'ascending'
                      : header.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : undefined
                  "
                  class="group/th h-8 whitespace-nowrap px-2.5 text-left align-middle text-xs font-medium text-muted-foreground"
                  :class="[
                    stickyHeaders
                      ? 'sticky top-0 z-20 bg-background'
                      : 'relative',
                    isNumericColumn(header.column) ? 'text-right' : '',
                    header.column.id === 'select'
                      ? 'vdt-sticky vdt-sticky-select z-30 pl-3 pr-0'
                      : '',
                    header.column.id === stickyColumnId
                      ? 'vdt-sticky vdt-sticky-edge z-30'
                      : '',
                    header.column.getCanSort()
                      ? 'cursor-pointer select-none transition-colors duration-fast hover:text-foreground'
                      : '',
                    header.column.getIsSorted() ? 'text-foreground' : '',
                    dragState.active && dragState.id === header.column.id
                      ? 'bg-accent text-foreground opacity-70'
                      : '',
                  ]"
                  @pointerdown="onHeaderPointerDown($event, header.column.id)"
                  @pointermove="onHeaderPointerMove"
                  @pointerup="endHeaderDrag"
                  @pointercancel="endHeaderDrag"
                  @click="onHeaderClick($event, header)"
                >
                  <div
                    class="inline-flex items-center gap-1"
                    :class="{
                      'flex-row-reverse': isNumericColumn(header.column),
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
                  <span
                    v-if="prefsKind && !isPinnedColumn(header.column.id)"
                    class="vdt-resizer absolute -right-1 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none justify-center"
                    :class="
                      resizeState.id === header.column.id ? 'vdt-resizing' : ''
                    "
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="`Resize ${columnLabel(header.column)} column`"
                    title="Drag to resize, double-click to reset"
                    @pointerdown="onResizePointerDown($event, header.column.id)"
                    @pointermove="onResizePointerMove"
                    @pointerup="onResizePointerUp"
                    @pointercancel="onResizePointerUp"
                    @click.stop
                    @dblclick.stop="resetColumnWidth(header.column.id)"
                  >
                    <span
                      class="h-full w-px bg-transparent transition-colors duration-fast"
                    />
                  </span>
                  <div
                    class="pointer-events-none absolute bottom-0 left-0 h-px w-full bg-border"
                  />
                </th>
              </tr>
            </thead>
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
                  @select="setUserVisibility(column, !column.getIsVisible())"
                >
                  {{ columnLabel(column) }}
                </ContextMenuCheckboxItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              v-if="prefsKind && hasColumnPrefs"
              @select="resetColumns"
            >
              <RotateCcw class="h-3.5 w-3.5 text-muted-foreground" />
              Reset columns
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <tbody
              class="[&_tr:last-child]:border-0"
              @click.left="onBodyClick"
              @contextmenu="onBodyContextMenu"
            >
              <template v-if="displayItems.length">
                <tr v-if="before > 0" aria-hidden="true">
                  <td
                    :colspan="visibleColumnCount"
                    :style="{ height: `${before}px` }"
                  />
                </tr>
                <tr
                  v-for="item in visibleItems"
                  :key="item.id"
                  v-memo="memoDeps(item)"
                  :data-item-id="item.id"
                  :data-state="
                    item.type === 'row' && item.row.getIsSelected()
                      ? 'selected'
                      : undefined
                  "
                  :data-cursor="
                    cursorVisible && cursorId === item.id ? '' : undefined
                  "
                  :style="{ height: `${rowHeight}px` }"
                  :class="
                    item.type === 'group'
                      ? 'vdt-row vdt-group-row group/row cursor-pointer border-b border-border-subtle bg-surface-1'
                      : [
                          'vdt-row group/row border-b border-border-subtle transition-colors duration-75 hover:bg-muted/60 data-[state=selected]:bg-primary/10 data-[state=selected]:hover:bg-primary/[0.14]',
                          getRowClasses(item.row.original),
                          hasRowClickListener ? 'cursor-pointer' : '',
                        ]
                  "
                  :aria-selected="
                    item.type === 'row' ? item.row.getIsSelected() : undefined
                  "
                  :aria-expanded="
                    item.type === 'group' ? !item.collapsed : undefined
                  "
                >
                  <template v-if="item.type === 'group'">
                    <td :colspan="visibleColumnCount" class="p-0">
                      <div
                        class="vdt-group-label sticky left-0 inline-flex items-center gap-2 pl-3 pr-4 text-xs"
                        :style="{ height: `${rowHeight - 1}px` }"
                      >
                        <Checkbox
                          class="row-checkbox opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100"
                          aria-label="Select group"
                          :checked="groupSelectionState(item.key)"
                          @update:checked="toggleGroupSelection(item.key)"
                          @click.stop
                        />
                        <ChevronRight
                          class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-fast"
                          :class="item.collapsed ? '' : 'rotate-90'"
                          aria-hidden="true"
                        />
                        <span class="font-medium text-foreground">{{
                          item.label
                        }}</span>
                        <span class="tabular-nums text-muted-foreground">{{
                          item.count
                        }}</span>
                      </div>
                    </td>
                  </template>
                  <template v-else>
                    <td
                      v-for="cell in item.row.getVisibleCells()"
                      :key="cell.id"
                      :class="cellClass(cell.column, item.row)"
                      :style="
                        cell.column.id === stickyColumnId
                          ? { left: `${SELECT_WIDTH}px` }
                          : undefined
                      "
                      :title="cellTitle(cell)"
                    >
                      <div
                        v-if="contentStyle(cell.column)"
                        class="truncate"
                        :style="contentStyle(cell.column)"
                      >
                        <FlexRender
                          :render="cell.column.columnDef.cell"
                          :props="cell.getContext()"
                        />
                      </div>
                      <div v-else class="truncate">
                        <FlexRender
                          :render="cell.column.columnDef.cell"
                          :props="cell.getContext()"
                        />
                      </div>
                    </td>
                  </template>
                </tr>
                <tr v-if="after > 0" aria-hidden="true">
                  <td
                    :colspan="visibleColumnCount"
                    :style="{ height: `${after}px` }"
                  />
                </tr>
              </template>
              <template v-else-if="loading && data.length === 0">
                <tr
                  v-for="index in 10"
                  :key="`skeleton-${index}`"
                  class="border-b border-border-subtle"
                  :style="{ height: `${rowHeight}px` }"
                  aria-hidden="true"
                >
                  <td
                    v-for="(column, columnIndex) in visibleLeafColumns"
                    :key="column.id"
                    class="px-2.5 py-1.5 align-middle"
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
                  </td>
                </tr>
              </template>
              <template v-else>
                <tr class="border-b-0">
                  <td :colspan="visibleColumnCount" class="p-0">
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
                      role="alert"
                      :icon="CloudOff"
                      :title="`Couldn't load ${emptyResourceName}`"
                    >
                      Check your connection to the cluster, then retry.
                      <span
                        class="mt-3 block select-text break-words rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs"
                        >{{ error.message }}</span
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
                  </td>
                </tr>
              </template>
            </tbody>
          </ContextMenuTrigger>
          <ContextMenuContent
            v-if="rowActions && rowActions?.length > 0"
            class="min-w-[13rem]"
          >
            <template v-for="(rowAction, index) in rowActions" :key="index">
              <template v-if="!rowAction.options">
                <ContextMenuSeparator
                  v-if="
                    isDestructiveAction(actionLabel(rowAction)) &&
                    index > 0 &&
                    !isDestructiveAction(actionLabel(rowActions[index - 1])) &&
                    !isRowActionBlocked(rowAction)
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
                  <ContextMenuShortcut v-if="actionShortcut(rowAction)">
                    <Kbd
                      :keys="actionShortcut(rowAction) || []"
                      size="sm"
                      variant="ghost"
                    />
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  v-if="index === 0 && keyboardEnabled"
                  @select="copyName(contextMenuSubject)"
                >
                  <Copy class="h-3.5 w-3.5 text-muted-foreground" />
                  Copy name
                  <ContextMenuShortcut>
                    <Kbd size="sm" variant="ghost">Y</Kbd>
                  </ContextMenuShortcut>
                </ContextMenuItem>
              </template>
              <template v-else-if="!isRowActionBlocked(rowAction)">
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <component
                      :is="actionIcon(actionLabel(rowAction))"
                      v-if="actionIcon(actionLabel(rowAction))"
                      class="h-3.5 w-3.5 text-muted-foreground"
                    />
                    <span v-else class="w-3.5" aria-hidden="true" />
                    {{ actionLabel(rowAction) }}
                    <ContextMenuShortcut v-if="actionShortcut(rowAction)">
                      <Kbd
                        :keys="actionShortcut(rowAction) || []"
                        size="sm"
                        variant="ghost"
                      />
                    </ContextMenuShortcut>
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem
                      v-for="(option, optionIndex) in rowAction.options(
                        contextMenuSubject as TData
                      )"
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
      </table>
      <div
        v-if="dragState.active"
        class="pointer-events-none absolute top-0 z-40 w-0.5 rounded-full bg-primary"
        :style="{
          left: `${dragState.indicatorLeft}px`,
          height: `${tableContainer?.scrollHeight || 0}px`,
        }"
        aria-hidden="true"
      />
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
        <!-- The wrapper shows the reason: a disabled button gets no hover. -->
        <span
          v-for="(rowAction, index) in massActions"
          :key="index"
          class="inline-flex"
          :title="massActionBlocks.get(rowAction) ?? undefined"
        >
          <Button
            size="xs"
            :variant="
              isDestructiveAction(actionLabel(rowAction))
                ? 'destructive'
                : 'ghost'
            "
            :disabled="!!massActionBlocks.get(rowAction)"
            @click="handleRowAction(rowAction)"
          >
            <component
              :is="actionIcon(actionLabel(rowAction))"
              v-if="actionIcon(actionLabel(rowAction))"
              class="h-3 w-3"
            />
            {{ actionLabel(rowAction) }}
            <Kbd
              v-if="keyboardEnabled && actionShortcut(rowAction)"
              :keys="actionShortcut(rowAction) || []"
              size="sm"
              variant="ghost"
            />
          </Button>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          @click="table.resetRowSelection()"
        >
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>
    </Transition>

    <TableShortcutsDialog
      v-if="keyboardEnabled"
      v-model:open="shortcutsOpen"
      :is-mac="isMac"
    />
    <RowOptionPicker
      v-if="picker"
      :title="picker.title"
      :options="picker.labels"
      :anchor="picker.anchor"
      @select="runPickerOption"
      @close="closePicker"
    />
  </div>
</template>

<style scoped>
/*
 * Sticky selection + name columns, only while scrolled horizontally (so the
 * row tints of the common case stay untouched): opaque cells that follow
 * the row's state (hover, selected, cursor) by layering the same
 * translucent tint over the canvas.
 */
.vdt-scrolled-x .vdt-sticky {
  position: sticky;
  z-index: 10;
  background-color: hsl(var(--background));
}
.vdt-sticky-select {
  left: 0;
}
.vdt-scrolled-x th.vdt-sticky,
th.vdt-sticky {
  z-index: 30;
}
.vdt-scrolled-x .vdt-row:hover > .vdt-sticky {
  background-image: linear-gradient(
    hsl(var(--muted) / 0.6),
    hsl(var(--muted) / 0.6)
  );
}
.vdt-scrolled-x .vdt-row[data-state="selected"] > .vdt-sticky {
  background-image: linear-gradient(
    hsl(var(--primary) / 0.1),
    hsl(var(--primary) / 0.1)
  );
}
.vdt-scrolled-x .vdt-row[data-cursor] > .vdt-sticky {
  background-image: linear-gradient(
    hsl(var(--accent) / 0.7),
    hsl(var(--accent) / 0.7)
  );
}
.vdt-scrolled-x .vdt-sticky-edge {
  box-shadow:
    inset -1px 0 0 hsl(var(--border)),
    6px 0 8px -6px rgb(0 0 0 / 0.25);
}

/* Keyboard cursor: accent rail on the first cell + accent row tint. */
.vdt-row[data-cursor] {
  background-color: hsl(var(--accent) / 0.7);
}
.vdt-row[data-cursor][data-state="selected"] {
  background-color: hsl(var(--primary) / 0.14);
}
.vdt-row[data-cursor] > td:first-child {
  box-shadow: inset 2px 0 0 hsl(var(--primary));
}

.vdt-group-row > td {
  background-color: hsl(var(--surface-1));
}

/* Resize handle: hairline on hover, accent while resizing. */
th:hover .vdt-resizer > span {
  background-color: hsl(var(--border-strong));
}
.vdt-resizer:hover > span,
.vdt-resizer.vdt-resizing > span {
  background-color: hsl(var(--primary));
  width: 2px;
}
</style>
