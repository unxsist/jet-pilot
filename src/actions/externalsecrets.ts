import { RowAction } from "@/components/tables/types";
import { syncExternalSecret } from "@/lib/operators/actions";
import { forceSyncPatch } from "@/lib/operators/externalSecrets";
import { annotateArgs, kindRef, kubectlFor } from "@/lib/kubectl/command";

export function actions<T>(): RowAction<T>[] {
  return [
    {
      label: "Sync now",
      kind: "force-sync",
      command: (row: T) =>
        kubectlFor(row as never, annotateArgs(kindRef(row as never), forceSyncPatch().metadata.annotations)),
      handler: (row: T) => syncExternalSecret(row as any),
    },
  ];
}
