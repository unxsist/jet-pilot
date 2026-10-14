import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, textColumn } from "@/lib/operators/columns";
import { listInWords } from "@/lib/operators/format";
import { monitorEndpoints, monitorTargetInWords } from "@/lib/operators/prometheus";

/* Prometheus Operator ServiceMonitors / PodMonitors: what they scrape, how often. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  textColumn("Scrapes", (row) => monitorTargetInWords(row)),
  mutedColumn("Endpoints", (row) => listInWords(monitorEndpoints(row), 2)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
