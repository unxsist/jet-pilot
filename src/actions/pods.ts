import { V1Pod } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { getResourceTabTitle } from "@/components/tables/identity";
import { allowed, rowTargets } from "@/lib/guardrails/guard";

/*
 * Extra pod actions: ephemeral debug containers and copying files from /
 * to a container. Used by the Pods view next to its own actions.
 */
type ContextAwarePod = V1Pod & {
  metadata: NonNullable<V1Pod["metadata"]> & {
    context: string;
    kubeConfig: string;
  };
};

export function actions<T extends ContextAwarePod>(
  addTab: any,
  spawnDialog: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _setSidePanelComponent?: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _router?: Router
): RowAction<T>[] {
  const target = (row: T) => ({
    context: row.metadata.context,
    namespace: row.metadata.namespace ?? "",
    kubeConfig: row.metadata.kubeConfig,
    pod: row,
  });

  return [
    {
      label: "Debug",
      kind: "debug",
      isAvailable: (row: T) => row.status?.phase === "Running",
      handler: (row: T) => {
        if (!allowed("debug", rowTargets([row], "Pod"))) return;
        spawnDialog({
          title: `Debug ${getResourceTabTitle(row)}`,
          message:
            "Attaches an ephemeral container with debugging tools to the running pod and opens a shell in it.",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/DebugPod.vue")
          ),
          props: { ...target(row), addTab },
          buttons: [],
        });
      },
    },
    {
      // Copying out of a container is allowed on read-only clusters; the
      // dialog blocks uploads.
      label: "Copy files",
      isAvailable: (row: T) => row.status?.phase === "Running",
      handler: (row: T) => {
        spawnDialog({
          title: `Copy files · ${row.metadata.name}`,
          message:
            "Copies a file or directory between a container and this computer (kubectl cp, needs tar in the container).",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/CopyFiles.vue")
          ),
          props: target(row),
          buttons: [],
        });
      },
    },
  ];
}
