/*
 * Cheap-under-churn row handling for VirtualDataTable.
 *
 * List views replace their rows wholesale on every refresh (every row a new
 * object, even when nothing changed). Three layers keep that cheap:
 *
 * 1. `createRowReconciler`: rows whose identity (context/uid) and version
 *    (resourceVersion + metrics) did not change are swapped back for the
 *    object seen last time. Everything downstream keyed by object identity
 *    (row model, search index, v-memo'd rows, cell component props) hits.
 * 2. `getStableCoreRowModel`: a TanStack core row model that reuses the
 *    `Row` objects (and their value / cell caches) of unchanged rows.
 * 3. `createSearchIndex`: one precomputed lower-case search string per row
 *    (cached per row object), so a filter keystroke is a single
 *    `String.includes` per row.
 */
import { markRaw } from "vue";
import {
  createRow,
  memo,
  type Column,
  type Row,
  type RowData,
  type RowModel,
  type Table,
} from "@tanstack/vue-table";

interface VersionedRow {
  metadata?: { resourceVersion?: string };
  metrics?: { timestamp?: string; window?: string }[];
  metricsHistory?: { ts?: number }[];
  __rowVersion?: string | number;
}

/**
 * Version of a row: changes whenever anything the table shows may change.
 * `__rowVersion` (data layer provided) wins; otherwise the resourceVersion
 * plus the metrics attached to the row (metrics change without the object's
 * resourceVersion changing). `null`: unversioned (e.g. Helm releases, log
 * lines): such rows are never reused.
 */
export function rowVersion(row: unknown): string | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const r = row as VersionedRow;
  if (r.__rowVersion !== undefined && r.__rowVersion !== null) {
    return String(r.__rowVersion);
  }

  const resourceVersion = r.metadata?.resourceVersion;
  if (!resourceVersion) {
    return null;
  }

  let version = resourceVersion;
  if (Array.isArray(r.metrics) && r.metrics.length > 0) {
    version += `|m${r.metrics.length}:${r.metrics
      .map((m) => m?.timestamp ?? "")
      .join(",")}`;
  }
  if (Array.isArray(r.metricsHistory) && r.metricsHistory.length > 0) {
    version += `|h${r.metricsHistory.length}:${
      r.metricsHistory[r.metricsHistory.length - 1]?.ts ?? ""
    }`;
  }
  return version;
}

const markRawSafe = <T>(row: T): T =>
  row && typeof row === "object" && Object.isExtensible(row)
    ? (markRaw(row as object) as T)
    : row;

/**
 * Returns a function mapping a freshly fetched list onto the objects seen
 * last time: unchanged rows (same id + version) keep their previous object.
 * Rows are marked raw so nothing ever wraps them in deep reactive proxies.
 */
export function createRowReconciler<T>(
  getId: (row: T) => string | null,
  getVersion: (row: T) => string | null = rowVersion
) {
  let previous = new Map<string, { version: string; row: T }>();

  return (rows: readonly T[]): T[] => {
    const next = new Map<string, { version: string; row: T }>();
    const result = new Array<T>(rows.length);

    for (let i = 0; i < rows.length; i++) {
      const incoming = rows[i];
      const id = getId(incoming);
      const version = id === null ? null : getVersion(incoming);

      if (id === null || version === null) {
        result[i] = markRawSafe(incoming);
        continue;
      }

      const known = previous.get(id);
      const row =
        known && (known.row === incoming || known.version === version)
          ? known.row
          : markRawSafe(incoming);

      result[i] = row;
      next.set(id, { version, row });
    }

    previous = next;
    return result;
  };
}

/**
 * TanStack core row model that reuses the Row objects of rows whose
 * original object did not change (see createRowReconciler), keeping their
 * value and cell caches. Flat data only (no sub rows). The cache is dropped
 * whenever the column definitions change.
 */
export function getStableCoreRowModel<TData extends RowData>(): (
  table: Table<TData>
) => () => RowModel<TData> {
  return (table) => {
    let cache = new Map<string, Row<TData>>();
    let cachedColumns: unknown = null;

    return memo(
      () => [table.options.data, table._getColumnDefs()],
      (data, columnDefs) => {
        if (columnDefs !== cachedColumns) {
          cache = new Map();
          cachedColumns = columnDefs;
        }

        const next = new Map<string, Row<TData>>();
        const rows: Row<TData>[] = new Array(data.length);

        for (let i = 0; i < data.length; i++) {
          const original = data[i];
          const id = table._getRowId(original, i);
          let row = cache.get(id);

          if (row && row.original === original) {
            row.index = i;
          } else {
            row = createRow(table, id, original, i, 0, undefined, undefined);
          }

          rows[i] = row;
          next.set(id, row);
        }

        cache = next;

        /* rowsById (a 20k-key object) is only built when something asks. */
        let rowsById: Record<string, Row<TData>> | null = null;
        const model = { rows, flatRows: rows } as RowModel<TData>;
        Object.defineProperty(model, "rowsById", {
          enumerable: true,
          get: () => (rowsById ??= Object.fromEntries(next)),
        });
        return model;
      },
      {
        key: "getStableCoreRowModel",
        debug: () => false,
      }
    );
  };
}

/**
 * TanStack's sorted row model without its per-sort `{ ...row }` copy of
 * every Row (≈60 properties each, and new objects on every sort): sorts a
 * shallow copy of the row array, keeping Row identities. Same semantics
 * (sortUndefined, invertSorting, desc, stable by index); flat data only.
 */
export function getStableSortedRowModel<TData extends RowData>(): (
  table: Table<TData>
) => () => RowModel<TData> {
  return (table) =>
    memo(
      () => [table.getState().sorting, table.getPreSortedRowModel()],
      (sorting, rowModel) => {
        if (!rowModel.rows.length || !sorting?.length) {
          return rowModel;
        }

        const entries = sorting
          .map((sort) => {
            const column = table.getColumn(sort.id);
            return column?.getCanSort()
              ? {
                  id: sort.id,
                  desc: !!sort.desc,
                  sortUndefined: column.columnDef.sortUndefined,
                  invert: !!column.columnDef.invertSorting,
                  sortingFn: column.getSortingFn(),
                }
              : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => !!entry);

        if (entries.length === 0) {
          return rowModel;
        }

        const rows = rowModel.rows.slice();
        rows.sort((rowA, rowB) => {
          for (const entry of entries) {
            let result = 0;
            if (entry.sortUndefined) {
              const aUndefined = rowA.getValue(entry.id) === undefined;
              const bUndefined = rowB.getValue(entry.id) === undefined;
              if (aUndefined || bUndefined) {
                if (entry.sortUndefined === "first") {
                  if (aUndefined !== bUndefined) return aUndefined ? -1 : 1;
                } else if (entry.sortUndefined === "last") {
                  if (aUndefined !== bUndefined) return aUndefined ? 1 : -1;
                } else {
                  result =
                    aUndefined && bUndefined
                      ? 0
                      : aUndefined
                        ? entry.sortUndefined
                        : -entry.sortUndefined;
                }
                if (aUndefined && bUndefined) continue;
              }
            }
            if (result === 0) {
              result = entry.sortingFn(rowA, rowB, entry.id);
            }
            if (result !== 0) {
              if (entry.desc) result *= -1;
              if (entry.invert) result *= -1;
              return result;
            }
          }
          return rowA.index - rowB.index;
        });

        return { rows, flatRows: rows, rowsById: rowModel.rowsById };
      },
      { key: "getStableSortedRowModel", debug: () => false }
    );
}

const isDigit = (code: number) => code >= 48 && code <= 57;

/**
 * Natural, ASCII case-insensitive string compare (`web-2` < `web-10`):
 * digit runs compare numerically, everything else by code unit, the same
 * order as TanStack's "alphanumeric" sorting without its regex split per
 * comparison (and faster than Intl.Collator with numeric collation).
 */
export function naturalCompare(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  let i = 0;
  let j = 0;
  while (i < la && j < lb) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(j);
    if (isDigit(ca) && isDigit(cb)) {
      let si = i;
      while (
        si < la - 1 &&
        a.charCodeAt(si) === 48 &&
        isDigit(a.charCodeAt(si + 1))
      )
        si++;
      let sj = j;
      while (
        sj < lb - 1 &&
        b.charCodeAt(sj) === 48 &&
        isDigit(b.charCodeAt(sj + 1))
      )
        sj++;
      let ei = si;
      while (ei < la && isDigit(a.charCodeAt(ei))) ei++;
      let ej = sj;
      while (ej < lb && isDigit(b.charCodeAt(ej))) ej++;
      if (ei - si !== ej - sj) return ei - si - (ej - sj);
      for (let k = 0; k < ei - si; k++) {
        const d = a.charCodeAt(si + k) - b.charCodeAt(sj + k);
        if (d !== 0) return d;
      }
      i = ei;
      j = ej;
      continue;
    }
    if (ca >= 65 && ca <= 90) ca += 32;
    if (cb >= 65 && cb <= 90) cb += 32;
    if (ca !== cb) return ca - cb;
    i++;
    j++;
  }
  return la - i - (lb - j);
}

/**
 * Default sorting: numbers numerically, everything else with
 * `naturalCompare`.
 */
export const naturalSortingFn = <TData>(
  rowA: Row<TData>,
  rowB: Row<TData>,
  columnId: string
): number => {
  const a = rowA.getValue(columnId);
  const b = rowB.getValue(columnId);
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return naturalCompare(
    a === null || a === undefined ? "" : String(a),
    b === null || b === undefined ? "" : String(b)
  );
};

/** Columns whose values feed the search string (TanStack's global filter rules). */
export function searchableColumns<TData>(
  table: Table<TData>
): Column<TData, unknown>[] {
  if (table.options.enableGlobalFilter === false) {
    return [];
  }

  return table
    .getAllLeafColumns()
    .filter(
      (column) =>
        !!column.accessorFn &&
        column.columnDef.enableGlobalFilter !== false &&
        column.id !== "select" &&
        column.id !== "actions"
    );
}

/** Lower-case search string of a row: its searchable values, NUL separated. */
export function buildSearchText<TData>(
  row: Row<TData>,
  columns: Column<TData, unknown>[]
): string {
  let text = "";
  for (const column of columns) {
    const value = row.getValue(column.id);
    if (typeof value === "string" || typeof value === "number") {
      text += `${String(value).toLowerCase()}\u0000`;
    }
  }
  return text;
}

/**
 * Search strings cached per row object; reset when the searchable columns
 * change. Unchanged rows (reconciled) never rebuild their string.
 */
export function createSearchIndex<TData>() {
  let cache = new WeakMap<object, string>();
  let columnsKey = "";

  const textOf = (row: Row<TData>, columns: Column<TData, unknown>[]) => {
    const key = row.original as unknown as object;
    if (!key || typeof key !== "object") {
      return buildSearchText(row, columns);
    }

    let text = cache.get(key);
    if (text === undefined) {
      text = buildSearchText(row, columns);
      cache.set(key, text);
    }
    return text;
  };

  return {
    /** Rows (in order) whose search string contains the query. */
    filter(
      rows: Row<TData>[],
      query: string,
      columns: Column<TData, unknown>[]
    ): Row<TData>[] {
      const key = columns.map((column) => column.id).join("\u0000");
      if (key !== columnsKey) {
        cache = new WeakMap();
        columnsKey = key;
      }

      const needle = query.trim().toLowerCase();
      if (!needle) {
        return rows;
      }

      const result: Row<TData>[] = [];
      for (const row of rows) {
        if (textOf(row, columns).includes(needle)) {
          result.push(row);
        }
      }
      return result;
    },
    reset() {
      cache = new WeakMap();
      columnsKey = "";
    },
  };
}
