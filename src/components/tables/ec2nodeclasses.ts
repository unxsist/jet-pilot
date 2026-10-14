import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { readyState } from "@/lib/operators/format";
import { amiInWords, nodeClassRole } from "@/lib/operators/karpenter";

/* Karpenter EC2NodeClasses: ready, AMI, node role. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => readyState(row)),
  textColumn("AMI", (row) => amiInWords(row)),
  mutedColumn("Role", (row) => nodeClassRole(row)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
