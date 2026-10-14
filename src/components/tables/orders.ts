import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import { listInWords } from "@/lib/operators/format";
import { orderState } from "@/lib/operators/certManager";

/* cert-manager ACME Orders: state, domains, what the CA said. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => orderState(row)),
  mutedColumn("Domains", (row) => listInWords(row.spec?.dnsNames ?? [], 1)),
  mutedColumn("Reason", (row) => row.status?.reason),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
