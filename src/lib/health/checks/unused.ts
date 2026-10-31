/*
 * What's possibly left over: workloads scaled to zero for a long time,
 * Services that select no pods, claims no pod mounts and volumes nobody
 * claims. "Possibly": only the owner knows, so these stay quiet. Pure.
 */
import { toMs } from "@/lib/resources/format";
import { DAY_MS, dayText } from "./days";
import type { RiskItem } from "./rules";
import { selects, type Scope, type Workload } from "./workloads";

/** Scaled to zero and untouched for this long counts as unused. */
export const IDLE_MS = 30 * DAY_MS;

/** When anyone last wrote the object: its newest managedFields entry, else its creation. */
export function lastChange(object: any): number | null {
  const times = (object?.metadata?.managedFields ?? [])
    .map((entry: any) => toMs(entry?.time))
    .filter((t: number | null): t is number => t !== null);
  return times.length ? Math.max(...times) : toMs(object?.metadata?.creationTimestamp);
}

const claimsOf = (spec: any): string[] =>
  (spec?.volumes ?? []).map((v: any) => v?.persistentVolumeClaim?.claimName).filter(Boolean);

export interface UnusedInput extends Scope {
  now: number;
  workloads: Workload[];
  pods: any[];
  services: any[];
  claims: any[];
  volumes: any[];
}

export function unusedRisks(input: UnusedInput): RiskItem[] {
  const items: RiskItem[] = [];
  const item = (rule: string, kind: string, apiVersion: string, raw: any, detail?: string): RiskItem => ({
    rule,
    context: input.context,
    kubeConfig: input.kubeConfig,
    object: { kind, name: raw?.metadata?.name, namespace: raw?.metadata?.namespace || undefined, apiVersion },
    detail,
    raw,
  });

  for (const w of input.workloads) {
    if (w.replicas !== 0) continue;
    const changed = lastChange(w.raw);
    if (changed === null || input.now - changed < IDLE_MS) continue;
    items.push({ ...item("scaled-to-zero", w.kind, w.apiVersion, w.raw, `Unchanged since ${dayText(changed)}`), order: changed });
  }

  const running = input.pods.filter((p) => p?.status?.phase !== "Succeeded" && p?.status?.phase !== "Failed");
  for (const service of input.services) {
    const selector = service?.spec?.selector;
    if (service?.spec?.type === "ExternalName" || !selector || !Object.keys(selector).length) continue;
    const ns = service.metadata?.namespace;
    if (input.pods.some((p) => p?.metadata?.namespace === ns && selects(selector, p?.metadata?.labels ?? {}))) continue;
    items.push(item("service-no-pods", "Service", "v1", service));
  }

  // Claims in use: mounted by a pod, or by a workload that will start pods again.
  const used = new Set<string>();
  for (const pod of running) for (const claim of claimsOf(pod.spec)) used.add(`${pod.metadata?.namespace}/${claim}`);
  for (const w of input.workloads) {
    if (w.replicas === 0) continue;
    for (const claim of claimsOf(w.spec)) used.add(`${w.namespace}/${claim}`);
  }
  for (const claim of input.claims) {
    if (claim?.status?.phase !== "Bound") continue;
    const ns = claim.metadata?.namespace;
    if (used.has(`${ns}/${claim.metadata?.name}`)) continue;
    const size = claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage;
    items.push(item("unused-claim", "PersistentVolumeClaim", "v1", claim, size ? String(size) : undefined));
  }

  for (const volume of input.volumes) {
    const phase = volume?.status?.phase;
    if (phase !== "Released" && phase !== "Available") continue;
    const size = volume.spec?.capacity?.storage;
    items.push(
      item(
        "released-volume",
        "PersistentVolume",
        "v1",
        volume,
        [phase === "Released" ? "Released by its claim" : "Never claimed", size, volume.spec?.storageClassName].filter(Boolean).join(" · ")
      )
    );
  }
  return items;
}
