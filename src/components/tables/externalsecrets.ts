import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { externalSecretState, storeRef, targetSecretName } from "@/lib/operators/externalSecrets";

/* External Secrets ExternalSecrets: sync state, store, target secret, last sync. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => externalSecretState(row)),
  mutedColumn("Store", (row) => storeRef(row)?.name),
  textColumn("Secret", (row) => targetSecretName(row)),
  ageColumn<any>((row) => row.status?.refreshTime, "Last sync"),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
