/*
 * Shell shortcut of the resource graph panel. Edit YAML, Describe and Logs
 * come with the side panel header (shared with the tables); a shell opens
 * the same tab as the pods table's Shell action.
 */
import type { V1Pod } from "@kubernetes/client-node";
import type { ContextAwareKubernetesObject } from "@/components/tables/types";
import {
  getResourceTabId,
  getResourceTabTitle,
} from "@/components/tables/identity";
import type { GraphObject, TopoNode } from "@/lib/clusterGraph";

export interface GraphActionDeps {
  addTab: any;
  spawnDialog: any;
  setSidePanelComponent: any;
}

/** A pod to open a shell in: the pod itself, or a running pod of a workload. */
export function shellTarget(node: TopoNode): GraphObject | null {
  const isRunning = (pod: GraphObject) =>
    pod.status?.phase === "Running" && !pod.metadata.deletionTimestamp;
  if (node.kind === "Pod") {
    return node.object && isRunning(node.object) ? node.object : null;
  }
  const pods = node.pods || [];
  const ready = pods.find(
    (pod) =>
      isRunning(pod) &&
      (pod.status?.conditions || []).some(
        (c: any) => c.type === "Ready" && c.status === "True"
      )
  );
  return ready || pods.find(isRunning) || null;
}

export function openShell(deps: GraphActionDeps, pod: GraphObject) {
  const row = pod as unknown as ContextAwareKubernetesObject;
  const spec = (pod as unknown as V1Pod).spec;
  const running = (pod.status?.containerStatuses || []).find(
    (status: any) => status.state?.running
  );
  const container =
    spec?.containers?.find((c) => c.name === running?.name) ||
    spec?.containers?.[0];
  if (!container) return;
  deps.addTab(
    getResourceTabId("shell", row, container.name),
    getResourceTabTitle(row, container.name),
    defineAsyncComponent(() => import("@/views/Shell.vue")),
    {
      kubeConfig: row.metadata.kubeConfig,
      context: row.metadata.context,
      namespace: row.metadata?.namespace ?? "",
      pod,
      container,
    },
    "shell"
  );
}
