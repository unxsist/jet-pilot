/*
 * The history of one object, read on demand (a side panel, `likelyCause`):
 * the object and, with `chain`, its owners (Pod → ReplicaSet →
 * Deployment) and the ConfigMaps and Secrets its pods use, from the
 * cluster (revisions, managedFields, Helm) and the recorder.
 *
 * ConfigMaps and Secrets are read as metadata only, so no value crosses
 * from the backend. Reads are cached for a few seconds: a panel and the
 * Problems tab ask about the same objects.
 */
import { apiPath, kubeRequest, type KubeTarget } from "@/lib/kubeApi";
import { refPath, type ObjectRef } from "@/lib/resources/kinds";
import { podUses } from "@/lib/resources/pod";
import { releaseHistory } from "@/lib/helmApi";
import { labelSelectorToString } from "@/lib/workloads";
import { error as logError } from "@/lib/logger";
import { mergeChanges, type Change, type ChangeTarget } from "./model";
import { listRecorded } from "./recorded";
import {
  fromControllerRevisions,
  fromHelmHistory,
  fromManagedFields,
  fromNodes,
  fromRecords,
  fromReplicaSets,
  lastDays,
  type Window,
} from "./sources";

/** Metadata only (with managedFields): what a list or GET of Secrets should return. */
export const METADATA_LIST = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1";
export const METADATA_ONE = "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1";

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<any> }>();

/** A GET, shared with callers asking for the same path within a few seconds; null when not found. */
export function cachedGet<T = any>(target: ChangeTarget, path: string, accept?: string): Promise<T | null> {
  const key = [target.context, target.kubeConfig, path, accept ?? ""].join("\u0000");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const kubeTarget: KubeTarget = { context: target.context, kubeConfig: target.kubeConfig || undefined };
  const value = kubeRequest<T>(kubeTarget, path, accept ? { accept } : {}).catch((e) => {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

const DATA_KINDS = new Set(["ConfigMap", "Secret"]);
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const HISTORY_KINDS = new Set([...WORKLOADS, ...DATA_KINDS, "Node", "CronJob", "Job"]);

const getRef = (target: ChangeTarget, ref: ObjectRef) => {
  const path = refPath(ref);
  if (!path) return Promise.resolve(null);
  return cachedGet(target, path, DATA_KINDS.has(ref.kind) ? METADATA_ONE : undefined);
};

const refOf = (object: any): ObjectRef => ({
  kind: object.kind,
  name: object.metadata?.name,
  namespace: object.metadata?.namespace || undefined,
});

/* The controller owning `object`, fetched. */
async function ownerOf(target: ChangeTarget, object: any): Promise<any | null> {
  const owner = (object.metadata?.ownerReferences ?? []).find((r: any) => r.controller);
  if (!owner) return null;
  const fetched = await getRef(target, { kind: owner.kind, name: owner.name, namespace: object.metadata?.namespace, apiVersion: owner.apiVersion });
  return fetched ? { ...fetched, kind: owner.kind } : null;
}

const selectorOf = (workload: any) => labelSelectorToString(workload.spec?.selector) || undefined;

async function revisionsOf(target: ChangeTarget, workload: any, window: Window): Promise<Change[]> {
  const namespace = workload.metadata?.namespace;
  const labelSelector = selectorOf(workload);
  if (!labelSelector) return [];
  const resource = workload.kind === "Deployment" ? "replicasets" : "controllerrevisions";
  const list = await cachedGet<{ items?: any[] }>(target, apiPath({ apiVersion: "apps/v1", resource, namespace, query: { labelSelector } }));
  const items = list?.items ?? [];
  const changes =
    workload.kind === "Deployment" ? fromReplicaSets(target, items, window) : fromControllerRevisions(target, items, window);
  return changes.filter((c) => c.object.uid === workload.metadata?.uid);
}

async function helmOf(target: ChangeTarget, workload: any, window: Window): Promise<Change[]> {
  const annotations = workload.metadata?.annotations ?? {};
  const name = annotations["meta.helm.sh/release-name"];
  const namespace = annotations["meta.helm.sh/release-namespace"] ?? workload.metadata?.namespace;
  if (!name || !namespace) return [];
  const history = await releaseHistory({ context: target.context, kubeConfig: target.kubeConfig || undefined }, namespace, name);
  return fromHelmHistory(target, { name, namespace }, history, window);
}

/* Each source on its own: one that fails (forbidden, no Helm) leaves the others. */
const settle = async (label: string, work: Promise<Change[]>): Promise<Change[]> => {
  try {
    return await work;
  } catch (e) {
    logError(`Changes: couldn't read ${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

export interface HistoryOptions {
  /** Include owners and the ConfigMaps and Secrets its pods use. */
  chain?: boolean;
  window?: Window;
}

/** Changes of an object (and with `chain`, of what it depends on), newest first. */
export async function objectHistory(target: ChangeTarget, ref: ObjectRef, options: HistoryOptions = {}): Promise<Change[]> {
  const window = options.window ?? lastDays();
  const object = await getRef(target, ref);
  if (!object) return [];
  const self = { ...object, kind: ref.kind };

  // The object, then its owners up to the workload.
  const subjects: any[] = [self];
  if (options.chain || ["Pod", "ReplicaSet", "Job"].includes(ref.kind)) {
    let current = self;
    for (let depth = 0; depth < 3; depth++) {
      const owner = await ownerOf(target, current).catch(() => null);
      if (!owner) break;
      subjects.push(owner);
      current = owner;
    }
  }
  const workload = subjects.find((s) => WORKLOADS.has(s.kind));

  // The ConfigMaps and Secrets its pods use.
  const podSpec = self.kind === "Pod" ? self.spec : workload?.spec?.template?.spec;
  const configRefs =
    options.chain || WORKLOADS.has(ref.kind)
      ? podUses({ spec: podSpec, metadata: { namespace: ref.namespace } } as any)
          .filter((use) => use.ref && DATA_KINDS.has(use.kind))
          .map((use) => use.ref!)
      : [];
  const configs = (await Promise.all(configRefs.map((r) => getRef(target, r).then((o) => (o ? { ...o, kind: r.kind } : null)).catch(() => null)))).filter(
    Boolean
  );

  const historyObjects = [...subjects, ...configs].filter((o) => HISTORY_KINDS.has(o.kind));
  const refs = historyObjects.map(refOf);

  const parts = await Promise.all([
    settle("revisions", workload ? revisionsOf(target, workload, window) : Promise.resolve([])),
    settle("Helm history", workload ? helmOf(target, workload, window) : Promise.resolve([])),
    settle(
      "managed fields",
      Promise.resolve(historyObjects.flatMap((o) => fromManagedFields(target, o.kind, [o], window)))
    ),
    settle("node conditions", Promise.resolve(self.kind === "Node" ? fromNodes(target, [self], window) : [])),
    settle(
      "recorded changes",
      listRecorded({
        targets: [{ context: target.context, kubeConfig: target.kubeConfig, namespaces: ["all"] }],
        objects: refs,
      }).then((clusters) => clusters.flatMap((c) => fromRecords(target, c.records)))
    ),
  ]);
  const from = window.from;
  return mergeChanges(parts.flat()).filter((c) => Date.parse(c.at) >= from);
}
