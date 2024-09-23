import { CoreV1Event } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { formatResourceKind } from "@/lib/utils";

export function actions<T extends CoreV1Event>(
  addTab: any,
  spawnDialog: any,
  router: Router,
  context: string,
  kubeConfig: string
): RowAction<T>[] {
  return [
    {
      label: "Go to object",
      handler: (row: T) => {
        router.push({
          path: `/${formatResourceKind(
            row.involvedObject.kind as string
          ).toLowerCase()}`,
          query: {
            resource: formatResourceKind(row.involvedObject.kind as string),
            uid: row.involvedObject.uid,
          },
        });
      },
    },
  ];
}
