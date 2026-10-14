import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { issuerType } from "@/lib/operators/certManager";
import { readyState } from "@/lib/operators/format";

/* cert-manager Issuers (and ClusterIssuers): ready, type, where from. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => readyState(row)),
  textColumn("Type", (row) => issuerType(row).type),
  mutedColumn("Issues from", (row) => issuerType(row).detail),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
