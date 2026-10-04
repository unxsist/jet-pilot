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
 *                            // ".metadata.labels['app']" (no filters)
 *     type?: "string" | "integer" | "number" | "boolean" | "date";
 *     priority?: number;     // > 0: hidden by default (kubectl -o wide)
 *     description?: string;  // header tooltip
 *   }[]
 *
 * Columns are taken from the first rows (union, first-seen order). Names that
 * already exist as columns (Name, Namespace, Age, ...) are skipped.
 */
import type { ColumnDef } from "@tanstack/vue-table";
import { formatAge, toDate } from "./age";
import { formatDateTime } from "@/lib/utils";

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

type Segment = { key: string } | { index: number } | { wildcard: true };

const pathCache = new Map<string, Segment[] | null>();

/** Parses `.a.b[0]['c.d'][*]` (optionally wrapped in `{}` / prefixed `$`). */
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

/** Evaluates a simple JSONPath; wildcards collect arrays. */
export function evaluateJsonPath(object: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  if (!segments) return undefined;

  let current: unknown[] = [object];
  let multi = false;
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if ("wildcard" in segment) {
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

/** Printer column definitions (union of the first rows, first-seen order). */
export function collectPrinterColumns(
  rows: readonly unknown[],
  sample = 50
): PrinterColumn[] {
  const seen = new Map<string, PrinterColumn>();
  for (const row of rows.slice(0, sample)) {
    const cells = (row as PrinterColumnRow)?.__printerColumns;
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) {
      if (!cell || typeof cell.name !== "string" || !cell.name) continue;
      if (!seen.has(cell.name)) {
        seen.set(cell.name, {
          name: cell.name,
          jsonPath: cell.jsonPath,
          type: cell.type,
          priority: cell.priority,
          description: cell.description,
        });
      }
    }
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
          cell: ({ row }) => formatAge(printerValue(row.original, column)),
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
        enableGlobalFilter: !isNumber,
        meta: {
          numeric: isNumber,
          headerTitle: column.description,
          defaultHidden: (column.priority ?? 0) > 0,
        },
      };
    });
}
