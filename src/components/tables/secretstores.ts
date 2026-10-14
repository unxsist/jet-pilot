import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { storeProvider, storeState } from "@/lib/operators/externalSecrets";

/* External Secrets (Cluster)SecretStores: valid, provider, where. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => storeState(row)),
  textColumn("Provider", (row) => storeProvider(row)?.name),
  mutedColumn("Where", (row) => storeProvider(row)?.detail),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
