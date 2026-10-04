import type { ColumnDef } from "@tanstack/vue-table";
import { formatDateTime, formatDateTimeDifference } from "@/lib/utils";

export const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return isNaN(date.getTime()) ? null : date;
};

/** Relative age (`3d4h`), or "-" when the timestamp is missing / invalid. */
export const formatAge = (value: unknown, now = new Date()): string => {
  const date = toDate(value);
  return date ? formatDateTimeDifference(date, now) : "-";
};

/**
 * Age-style column: relative time in the cell, the absolute timestamp as
 * tooltip, sorted chronologically (rows without timestamp sort first).
 */
export function ageColumn<T>(
  getTimestamp: (row: T) => unknown,
  header = "Age"
): ColumnDef<T> {
  const time = (row: T) => toDate(getTimestamp(row))?.getTime() ?? 0;

  return {
    id: header,
    header,
    accessorFn: (row) => formatAge(getTimestamp(row)),
    sortingFn: (a, b) => time(a.original) - time(b.original),
    enableGlobalFilter: false,
    meta: {
      numeric: true,
      class: () => "text-muted-foreground",
      title: (row: T) => {
        const date = toDate(getTimestamp(row));
        return date ? formatDateTime(date) : undefined;
      },
    },
  };
}
