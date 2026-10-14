import { RowAction } from "@/components/tables/types";
import { syncExternalSecret } from "@/lib/operators/actions";

export function actions<T>(): RowAction<T>[] {
  return [
    {
      label: "Sync now",
      kind: "force-sync",
      handler: (row: T) => syncExternalSecret(row as any),
    },
  ];
}
