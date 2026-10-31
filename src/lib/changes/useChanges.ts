/*
 * The change timeline of the active clusters (the Changes tab), newest
 * first:
 *
 * - live, from shared watches: ReplicaSets (rollouts), pods (restarts),
 *   nodes (conditions), events, and Argo CD / Flux (their history);
 * - read once when the tab opens (and on Refresh, or after a while):
 *   ControllerRevisions, managedFields (metadata-only lists: no Secret
 *   value crosses from the backend) and Helm history;
 * - the recorder's records, re-read when it records something new.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useWatchedList } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { apiPath } from "@/lib/kubeApi";
import { listReleases, releaseHistory } from "@/lib/helmApi";
import { useGitOps } from "@/lib/gitops/useGitOps";
import { error as logError } from "@/lib/logger";
import type { HealthTarget } from "@/lib/health/tabs";
import { cachedGet, METADATA_LIST } from "./history";
import { mergeChanges, type Change } from "./model";
import { listRecorded, onRecorded, recordingSince, type RecordedCluster } from "./recorded";
import {
  fromArgoApplications,
  fromControllerRevisions,
  fromEvents,
  fromFlux,
  fromHelmHistory,
  fromManagedFields,
  fromNodes,
  fromPods,
  fromRecords,
  fromReplicaSets,
  lastDays,
  type Window,
} from "./sources";

/* Read-once sources are read again after this long (or on Refresh). */
const STALE_MS = 2 * 60_000;
/* Helm releases whose history is read, newest first, per cluster. */
const MAX_HELM_RELEASES = 15;

const METADATA_KINDS: { kind: string; apiVersion: string; resource: string }[] = [
  { kind: "Deployment", apiVersion: "apps/v1", resource: "deployments" },
  { kind: "StatefulSet", apiVersion: "apps/v1", resource: "statefulsets" },
  { kind: "DaemonSet", apiVersion: "apps/v1", resource: "daemonsets" },
  { kind: "ConfigMap", apiVersion: "v1", resource: "configmaps" },
  { kind: "Secret", apiVersion: "v1", resource: "secrets" },
];

const scopesOf = (t: HealthTarget): (string | undefined)[] =>
  t.namespaces.length === 0 || t.namespaces.includes("all") ? [undefined] : t.namespaces;

/* One part of a cluster's history; failures (forbidden, no Helm) are logged and leave the rest. */
const part = async (label: string, work: () => Promise<Change[]>): Promise<Change[]> => {
  try {
    return await work();
  } catch (e) {
    logError(`Changes: couldn't read ${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

/** The read-once history of one cluster. */
async function readCluster(t: HealthTarget, window: Window): Promise<Change[]> {
  const target = { context: t.context, kubeConfig: t.kubeConfig };
  const scoped = scopesOf(t).flatMap((namespace) => [
    part(`ControllerRevisions in ${t.context}`, async () => {
      const list = await cachedGet<{ items?: any[] }>(target, apiPath({ apiVersion: "apps/v1", resource: "controllerrevisions", namespace }));
      return fromControllerRevisions(target, list?.items ?? [], window);
    }),
    ...METADATA_KINDS.map((k) =>
      part(`${k.kind} managed fields in ${t.context}`, async () => {
        const list = await cachedGet<{ items?: any[] }>(target, apiPath({ apiVersion: k.apiVersion, resource: k.resource, namespace }), METADATA_LIST);
        return fromManagedFields(target, k.kind, list?.items ?? [], window);
      })
    ),
  ]);
  const helm = part(`Helm history in ${t.context}`, async () => {
    const releases = (await listReleases(target, t.namespaces))
      .filter((r) => r.updated && Date.parse(r.updated) >= window.from)
      .sort((a, b) => Date.parse(b.updated!) - Date.parse(a.updated!))
      .slice(0, MAX_HELM_RELEASES);
    const histories = await Promise.all(
      releases.map((r) =>
        part(`the history of ${r.name}`, async () =>
          fromHelmHistory(target, r, await releaseHistory(target, r.namespace, r.name), window)
        )
      )
    );
    return histories.flat();
  });
  return (await Promise.all([...scoped, helm])).flat();
}

const read = new Map<string, { at: number; changes: Promise<Change[]> }>();
const targetKey = (t: HealthTarget) => JSON.stringify([t.context, t.kubeConfig, [...t.namespaces].sort()]);

export function useChanges(targets: () => HealthTarget[]) {
  const { settings } = injectStrict(SettingsContextStateKey);
  const window = shallowRef(lastDays());

  const watched = (resource: string, kind: string) =>
    useWatchedList<any>({
      resource: () => resource,
      kind: () => kind,
      targets: () => targets(),
      fallback: (r, t) => kubectlGetForContext<any>(r, t.context, t.kubeConfig, t.namespaces),
      forcePolling: () => kubectlPollingForced(settings.value),
    });
  const replicaSets = watched("replicasets.apps", "ReplicaSet");
  const pods = watched("pods", "Pod");
  const nodes = watched("nodes", "Node");
  const events = watched("events", "Event");
  const gitops = useGitOps();

  /* Rows are tagged with their cluster: group them per target. */
  const perTarget = (rows: any[], build: (target: { context: string; kubeConfig: string }, rows: any[]) => Change[]) => {
    const groups = new Map<string, { target: { context: string; kubeConfig: string }; rows: any[] }>();
    for (const row of rows) {
      const context = row.metadata?.context ?? "";
      const kubeConfig = row.metadata?.kubeConfig ?? "";
      const key = `${context}\u0000${kubeConfig}`;
      const group = groups.get(key) ?? { target: { context, kubeConfig }, rows: [] as any[] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].flatMap((g) => build(g.target, g.rows));
  };

  const live = computed(() => [
    ...perTarget(replicaSets.items.value, (t, rows) => fromReplicaSets(t, rows, window.value)),
    ...perTarget(pods.items.value, (t, rows) => fromPods(t, rows, window.value)),
    ...perTarget(nodes.items.value, (t, rows) => fromNodes(t, rows, window.value)),
    ...perTarget(events.items.value, (t, rows) => fromEvents(t, rows, window.value)),
  ]);

  const delivered = computed(() =>
    perTarget(
      gitops.deliveries.value.map((d) => d.object),
      (t, objects) => [
        ...fromArgoApplications(t, objects.filter((o) => o.kind === "Application"), window.value),
        ...fromFlux(
          t,
          objects.filter((o) => o.kind === "HelmRelease"),
          objects.filter((o) => o.kind === "Kustomization"),
          window.value
        ),
      ]
    )
  );

  /* ------------------------------------------------------ read once -- */

  const history = shallowRef<Change[]>([]);
  const reading = ref(false);
  const readAt = ref<number | null>(null);
  let generation = 0;

  const readAll = async (force = false) => {
    const list = targets();
    const run = ++generation;
    reading.value = true;
    window.value = lastDays();
    const results = await Promise.all(
      list.map((t) => {
        const key = targetKey(t);
        const hit = read.get(key);
        if (!force && hit && Date.now() - hit.at < STALE_MS) return hit.changes;
        const changes = readCluster(t, window.value);
        read.set(key, { at: Date.now(), changes });
        return changes;
      })
    );
    if (run !== generation) return;
    history.value = results.flat();
    readAt.value = Date.now();
    reading.value = false;
  };

  /* ------------------------------------------------------- recorded -- */

  const recordedClusters = shallowRef<RecordedCluster[]>([]);
  const recorded = computed(() =>
    recordedClusters.value.flatMap((c) => fromRecords({ context: c.context, kubeConfig: c.kubeConfig }, c.records))
  );
  const readRecorded = async () => {
    try {
      recordedClusters.value = await listRecorded({ targets: targets(), since: new Date(window.value.from).toISOString() });
    } catch (e) {
      logError(`Changes: couldn't read the recorded changes: ${e}`);
    }
  };

  let unlisten: (() => void) | null = null;
  let disposed = false;
  onRecorded((cluster) => {
    if (targets().some((t) => t.context === cluster.context)) void readRecorded();
  }).then((stop) => (disposed ? stop() : (unlisten = stop)));
  onScopeDispose(() => {
    disposed = true;
    unlisten?.();
  });

  watch(
    () => targets().map(targetKey).join("|"),
    () => {
      void readAll();
      void readRecorded();
    },
    { immediate: true }
  );

  const changes = computed(() =>
    mergeChanges([...recorded.value, ...live.value, ...delivered.value, ...history.value]).filter(
      (c) => Date.parse(c.at) >= window.value.from
    )
  );

  /* The first watches and reads are still on their way. */
  const loading = computed(
    () =>
      changes.value.length === 0 &&
      (reading.value || [replicaSets, pods, nodes, events].some((l) => l.loading.value && l.items.value.length === 0))
  );

  return {
    changes,
    loading,
    /** Re-reading the read-once sources. */
    reading,
    readAt,
    /** Since when the recorder runs for every active cluster (ISO), if it does. */
    recordingSince: computed(() => recordingSince(recordedClusters.value)),
    refresh: () => Promise.all([readAll(true), readRecorded()]),
  };
}
