import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn } from "@/lib/operators/columns";
import { authSourcesInWords } from "@/lib/operators/keda";

/* KEDA (Cluster)TriggerAuthentications: where the credentials come from. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  mutedColumn("Credentials from", (row) => authSourcesInWords(row).join(" · ")),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
