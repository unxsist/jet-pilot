import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { countColumn, mutedColumn, nameColumn, textColumn } from "@/lib/operators/columns";
import { ruleGroups, ruleSummary, rulesInWords } from "@/lib/operators/prometheus";
import { listInWords } from "@/lib/operators/format";

/* Prometheus Operator PrometheusRules: rule counts in words, the groups. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  textColumn("Rules", (row) => rulesInWords(row)),
  countColumn("Groups", (row) => ruleSummary(row).groups),
  mutedColumn("Group names", (row) => listInWords(ruleGroups(row).map((g) => g.name), 2)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
