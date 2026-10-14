import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { listInWords } from "@/lib/operators/format";
import { pushSecretState } from "@/lib/operators/externalSecrets";

/* External Secrets PushSecrets: state, the secret it pushes, the stores. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => pushSecretState(row)),
  textColumn("Secret", (row) => row.spec?.selector?.secret?.name),
  mutedColumn("Stores", (row) =>
    listInWords((row.spec?.secretStoreRefs ?? []).map((ref: any) => ref?.name).filter(Boolean), 2)
  ),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
