/*
 * Server-side printer columns (CRD additionalPrinterColumns / the Table API)
 * as table columns, for kinds without hand-written column definitions.
 *
 * Data contract (provided by the data layer, optional), per row:
 *
 *   row.__printerColumns: {
 *     name: string;          // column header, e.g. "Ready", "Status"
 *     value?: unknown;       // the cell value (Table API row cell); wins
 *     jsonPath?: string;     // or a simple JSONPath into the row:
 *                            // ".spec.replicas", ".spec.ports[*].port",
 *                            // ".metadata.labels['app']",
 *                            // '.status.conditions[?(@.type=="Ready")].status'
 *     type?: "string" | "integer" | "number" | "boolean" | "date";
 *     priority?: number;     // > 0: hidden by default (kubectl -o wide)
 *     description?: string;  // header tooltip
 *   }[]
 *
 * Columns are taken from the first rows (union, first-seen order), after the
 * columns a table passes itself (a CRD's additionalPrinterColumns, see
 * @/lib/crds). Names that already exist as columns (Name, Namespace, Age,
 * ...) are skipped.
 */
import { h } from "vue";
import type { ColumnDef } from "@tanstack/vue-table";
import { formatAge, toDate } from "./age";
import { formatDateTime, formatDateTimeDifference } from "@/lib/utils";
import {
  StatusDot,
  statusTextClass,
  statusTone,
  type StatusTone,
} from "@/components/ui/status";

export interface PrinterColumn {
  name: string;
  value?: unknown;
  jsonPath?: string;
  type?: string;
  priority?: number;
  description?: string;
}

interface PrinterColumnRow {
  __printerColumns?: PrinterColumn[];
}

interface Filter {
  /** Path below the element (`@`), e.g. `.type`. */
  path: Segment[];
  op?: "==" | "!=";
  value?: string | number | boolean;
}

type Segment =
  | { key: string }
  | { index: number }
  | { wildcard: true }
  | { filter: Filter };

const pathCache = new Map<string, Segment[] | null>();

/* `@.type=="Ready"`, `@.status != 'False'`, `@.ready` (exists). */
function parseFilter(expression: string): Filter | null {
  const match = expression
    .trim()
    .match(/^@((?:\.[\w-]+|\[['"][^'"]*['"]\])*)\s*(?:(==|!=)\s*(.+))?$/);
  if (!match) return null;
  const path = match[1] ? parseJsonPath(match[1]) : [];
  if (!path) return null;
  if (!match[2]) return { path };

  const raw = match[3].trim();
  let value: Filter["value"];
  if (/^(['"]).*\1$/.test(raw)) value = raw.slice(1, -1);
  else if (raw === "true" || raw === "false") value = raw === "true";
  else if (Number.isFinite(Number(raw))) value = Number(raw);
  else return null;
  return { path, op: match[2] as Filter["op"], value };
}

/* Plain key / index walk (filter paths have no wildcards). */
function walk(value: unknown, path: Segment[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    if ("key" in segment) {
      current = (current as Record<string, unknown>)[segment.key];
    } else if ("index" in segment && Array.isArray(current)) {
      current = current[segment.index];
    } else {
      return undefined;
    }
  }
  return current;
}

function matchesFilter(element: unknown, filter: Filter): boolean {
  const value = walk(element, filter.path);
  if (!filter.op) return value !== undefined && value !== null && value !== false;
  // Like kubectl: "1" equals 1, true equals "true".
  const equal = value !== undefined && String(value) === String(filter.value);
  return filter.op === "==" ? equal : !equal;
}

/**
 * Parses `.a.b[0]['c.d'][*][?(@.type=="Ready")]` (optionally wrapped in `{}`
 * / prefixed `$`).
 */
export function parseJsonPath(path: string): Segment[] | null {
  const cached = pathCache.get(path);
  if (cached !== undefined) return cached;

  let p = path.trim();
  if (p.startsWith("{") && p.endsWith("}")) p = p.slice(1, -1).trim();
  if (p.startsWith("$")) p = p.slice(1);

  const segments: Segment[] = [];
  let i = 0;
  let ok = true;
  while (i < p.length && ok) {
    const c = p[i];
    if (c === ".") {
      i++;
      let key = "";
      while (i < p.length && p[i] !== "." && p[i] !== "[") key += p[i++];
      if (!key) ok = false;
      else segments.push({ key });
    } else if (p.startsWith("[?(", i)) {
      const end = p.indexOf(")]", i);
      const filter = end < 0 ? null : parseFilter(p.slice(i + 3, end));
      if (!filter) {
        ok = false;
        break;
      }
      segments.push({ filter });
      i = end + 2;
    } else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) {
        ok = false;
        break;
      }
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === "*") segments.push({ wildcard: true });
      else if (/^-?\d+$/.test(inner)) segments.push({ index: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner))
        segments.push({ key: inner.slice(1, -1) });
      else ok = false;
    } else if (segments.length === 0) {
      // bare first key: "spec.replicas"
      let key = "";
      while (i < p.length && p[i] !== "." && p[i] !== "[") key += p[i++];
      segments.push({ key });
    } else {
      ok = false;
    }
  }

  const result = ok ? segments : null;
  if (pathCache.size > 500) pathCache.clear();
  pathCache.set(path, result);
  return result;
}

/**
 * Evaluates a simple JSONPath. Wildcards collect arrays; filters select
 * elements, of which the first is the value (like the API server's printer
 * columns).
 */
export function evaluateJsonPath(object: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  if (!segments) return undefined;

  let current: unknown[] = [object];
  let multi = false;
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if ("filter" in segment) {
        if (typeof value !== "object") continue;
        const elements = Array.isArray(value) ? value : Object.values(value);
        next.push(...elements.filter((e) => matchesFilter(e, segment.filter)));
      } else if ("wildcard" in segment) {
        multi = true;
        if (Array.isArray(value)) next.push(...value);
        else if (typeof value === "object") next.push(...Object.values(value));
      } else if ("index" in segment) {
        if (Array.isArray(value)) {
          next.push(
            value[
              segment.index < 0 ? value.length + segment.index : segment.index
            ]
          );
        }
      } else if (typeof value === "object") {
        next.push((value as Record<string, unknown>)[segment.key]);
      }
    }
    current = next;
  }

  const defined = current.filter((v) => v !== undefined);
  return multi ? defined : defined[0];
}

/** Display value of a printer column cell. */
export function printerValue(row: unknown, column: PrinterColumn): unknown {
  const cells = (row as PrinterColumnRow)?.__printerColumns;
  const cell = Array.isArray(cells)
    ? cells.find((c) => c?.name === column.name)
    : undefined;
  let value = cell?.value;
  if (value === undefined) {
    const path = cell?.jsonPath ?? column.jsonPath;
    value = path ? evaluateJsonPath(row, path) : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)
      )
      .join(", ");
  }
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Printer column definitions: `own` first (e.g. from the CRD), then the
 * union of the first rows' columns, first-seen order.
 */
export function collectPrinterColumns(
  rows: readonly unknown[],
  sample = 50,
  own: readonly PrinterColumn[] = []
): PrinterColumn[] {
  const seen = new Map<string, PrinterColumn>();
  const add = (cell: PrinterColumn) => {
    if (!cell || typeof cell.name !== "string" || !cell.name) return;
    if (!seen.has(cell.name)) {
      seen.set(cell.name, {
        name: cell.name,
        jsonPath: cell.jsonPath,
        type: cell.type,
        priority: cell.priority,
        description: cell.description,
      });
    }
  };
  own.forEach(add);
  for (const row of rows.slice(0, sample)) {
    const cells = (row as PrinterColumnRow)?.__printerColumns;
    if (Array.isArray(cells)) cells.forEach(add);
  }
  return [...seen.values()];
}

export const printerColumnId = (name: string) => `printer:${name}`;

/** Stable signature, to keep column identities while the set is unchanged. */
export const printerColumnsSignature = (columns: PrinterColumn[]) =>
  columns
    .map(
      (c) => `${c.name}|${c.type ?? ""}|${c.priority ?? 0}|${c.jsonPath ?? ""}`
    )
    .join("\u0000");

/*
 * Columns that carry a state ("Ready: True", "Status: Failed", "Phase:
 * Running") get a status dot; healthy values keep neutral text.
 */
const STATE_COLUMN = /^(ready|status|state|phase|health|synced|available|reconciled)$/i;

export const isStateColumn = (column: PrinterColumn) =>
  STATE_COLUMN.test(column.name.trim()) &&
  (!column.type || column.type === "string" || column.type === "boolean");

/* Operators also write phases in prose: "Cluster in healthy state". */
const proseTone = (text: string): StatusTone => {
  const lower = text.toLowerCase();
  if (/\b(unhealthy|not ready|degraded)\b/.test(lower)) return "warning";
  if (/\b(healthy|ready|running|available)\b/.test(lower)) return "success";
  if (/\b(waiting|pending|(in)?progress|provisioning|creating|upgrading|switching)\b/.test(lower)) {
    return "warning";
  }
  return "muted";
};

const stateCell = (value: unknown) => {
  const text = value === undefined || value === null ? "" : String(value);
  if (!text) return "";
  const tone = statusTone(text, proseTone(text));
  return h("span", { class: "inline-flex max-w-full items-center gap-2" }, [
    h(StatusDot, { tone }),
    h(
      "span",
      {
        class: [
          "truncate",
          tone === "success" ? "text-foreground" : statusTextClass[tone],
        ],
      },
      text
    ),
  ]);
};

/** Relative time; dates in the future (expiry, next run) read "in 3d". */
export const formatRelativeDate = (value: unknown, now = new Date()) => {
  const date = toDate(value);
  if (!date) return "-";
  return date.getTime() > now.getTime()
    ? `in ${formatDateTimeDifference(now, date)}`
    : formatAge(date, now);
};

/**
 * Column definitions for printer columns, skipping names already present
 * (compared case-insensitively against `existingHeaders`).
 */
export function printerColumnDefs(
  columns: PrinterColumn[],
  existingHeaders: readonly string[]
): ColumnDef<any, any>[] {
  const existing = new Set(existingHeaders.map((h) => h.toLowerCase()));
  return columns
    .filter((column) => !existing.has(column.name.toLowerCase()))
    .map((column): ColumnDef<any, any> => {
      const id = printerColumnId(column.name);
      const isDate = column.type === "date";
      const isNumber = column.type === "integer" || column.type === "number";

      if (isDate) {
        const time = (row: unknown) =>
          toDate(printerValue(row, column))?.getTime() ?? 0;
        return {
          id,
          header: column.name,
          accessorFn: (row) => time(row),
          cell: ({ row }) => formatRelativeDate(printerValue(row.original, column)),
          enableGlobalFilter: false,
          meta: {
            numeric: true,
            class: () => "text-muted-foreground",
            title: (row) => {
              const date = toDate(printerValue(row, column));
              return date ? formatDateTime(date) : undefined;
            },
            headerTitle: column.description,
            defaultHidden: (column.priority ?? 0) > 0,
          },
        };
      }

      return {
        id,
        header: column.name,
        accessorFn: (row) => {
          const value = printerValue(row, column);
          if (value === undefined || value === null) return "";
          if (isNumber) {
            const n = Number(value);
            return Number.isFinite(n) ? n : String(value);
          }
          return typeof value === "boolean" ? String(value) : value;
        },
        ...(isStateColumn(column)
          ? { cell: ({ getValue }: { getValue: () => unknown }) => stateCell(getValue()) }
          : {}),
        enableGlobalFilter: !isNumber,
        meta: {
          numeric: isNumber,
          headerTitle: column.description,
          defaultHidden: (column.priority ?? 0) > 0,
        },
      };
    });
}
