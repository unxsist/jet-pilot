import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { challengeHint, challengeState, challengeType } from "@/lib/operators/certManager";

/*
 * cert-manager ACME Challenges, a common failure point: the domain, the
 * state and the reason in plain words (the CA's own message as tooltip).
 */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  textColumn("Domain", (row) => row.spec?.dnsName),
  stateColumn((row) => challengeState(row)),
  {
    ...mutedColumn("Reason", (row) => challengeHint(row) ?? row.status?.reason),
    meta: {
      class: () => "text-muted-foreground",
      title: (row) => row.status?.reason || undefined,
    },
  },
  mutedColumn("Type", (row) => challengeType(row)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
