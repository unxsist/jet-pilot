/*
 * The events of one object, straight from the API (no kubectl): the
 * namespace's events for namespaced objects, every namespace's for
 * cluster-scoped ones (a node's events live in `default`), matched like
 * `kubectl describe` does, most recent first.
 */
import type { CoreV1Event } from "@kubernetes/client-node";
import { getEventLastSeen } from "@/components/tables/status";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import type { PanelTarget } from "./open";

export function eventsPath(object: { kind?: string; metadata?: { name?: string; namespace?: string; uid?: string } }) {
  const selector = [
    `involvedObject.kind=${object.kind ?? ""}`,
    `involvedObject.name=${object.metadata?.name ?? ""}`,
    ...(object.metadata?.uid ? [`involvedObject.uid=${object.metadata.uid}`] : []),
  ].join(",");
  return apiPath({
    apiVersion: "v1",
    resource: "events",
    namespace: object.metadata?.namespace || undefined,
    query: { fieldSelector: selector },
  });
}

export const byLastSeen = (a: CoreV1Event, b: CoreV1Event) =>
  (getEventLastSeen(b)?.getTime() ?? 0) - (getEventLastSeen(a)?.getTime() ?? 0);

export async function fetchEvents(target: PanelTarget, object: Parameters<typeof eventsPath>[0]): Promise<CoreV1Event[]> {
  const list = await kubeGet<{ items?: CoreV1Event[] }>(
    { context: target.context, kubeConfig: target.kubeConfig || undefined },
    eventsPath(object)
  );
  return [...(list?.items ?? [])].sort(byLastSeen);
}
