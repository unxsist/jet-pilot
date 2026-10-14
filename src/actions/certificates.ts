import { RowAction } from "@/components/tables/types";
import { canRenew } from "@/lib/operators/certManager";
import { renewCertificate } from "@/lib/operators/actions";

export function actions<T>(): RowAction<T>[] {
  return [
    {
      label: "Renew",
      kind: "renew",
      isAvailable: (row: T) => canRenew(row),
      handler: (row: T) => renewCertificate(row as any),
    },
  ];
}
