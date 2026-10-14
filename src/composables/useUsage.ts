/*
 * The usage charts of one object (the side panel's Usage section).
 *
 * Where the history comes from, per cluster (see the cluster's Metrics
 * setting): a Prometheus-compatible API found automatically or picked by
 * the user, queried through the service proxy for the chosen range; without
 * one (or with history turned off), metrics-server's last ~15 minutes from
 * the metrics service, live.
 *
 * Prometheus data refreshes every minute while the window is visible. A
 * failing automatic source is looked up again once before the error shows.
 */
import { useDocumentVisibility, useIntervalFn } from "@vueuse/core";
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import { subscribeMetrics, type MetricsMessage, type MetricsPoint, type MetricsState } from "@/lib/watch";
import { appendSample, metricSample } from "@/composables/usePodMetrics";
import { parseCpu, parseMemory } from "@/components/tables/metrics";
import { discoverCached, forgetDiscovery } from "@/lib/metrics/discovery";
import { PrometheusError, toPrometheusError, type PromSource, type SourceKind } from "@/lib/metrics/prometheus";
import { matchesPods } from "@/lib/metrics/promql";
import type { Sample } from "@/lib/metrics/series";
import { queryWindow, rangeSeconds, stepFor, type RangeId } from "@/lib/metrics/time";
import { fallbackUsage, fetchUsage, scopeOf, type Subject, type UsageData } from "@/lib/metrics/usage";
import type { MetricsSetting } from "@/lib/clusters/meta";
import type { KubeTarget } from "@/lib/kubeApi";

export type UsageSource =
  | { type: "prometheus"; source: PromSource; automatic: boolean; kind?: SourceKind }
  /** `reason`: history is off for the cluster, or no Prometheus was found. */
  | { type: "metrics-server"; reason: "off" | "none" };

export type UsageStatus = "loading" | "ready" | "error";

const REFRESH_MS = 60_000;

type PodMetric = Parameters<typeof metricSample>[0];
interface NodeMetric {
  metadata?: { name?: string };
  timestamp?: string;
  usage?: { cpu?: string; memory?: string };
}

export interface UsageOptions {
  subject: () => Subject;
  target: () => KubeTarget;
  /** The cluster's Metrics setting (unset: automatic). */
  setting: () => MetricsSetting | undefined;
  /** Namespaces the metrics service already polls for the context (shares its history). */
  namespaces: () => string[];
  range: Ref<RangeId>;
  /** Chart width in px: picks the query step. */
  width: Ref<number>;
}

export function useUsage(options: UsageOptions) {
  const status = ref<UsageStatus>("loading");
  const source = shallowRef<UsageSource | null>(null);
  const data = shallowRef<UsageData | null>(null);
  const error = shallowRef<PrometheusError | null>(null);
  /** Reloading with data on screen (charts dim instead of a skeleton). */
  const refreshing = ref(false);
  /** metrics-server's state for the fallback. */
  const fallbackState = ref<MetricsState | null>(null);

  const subjectKey = computed(() => {
    const s = options.subject();
    const t = options.target();
    return JSON.stringify([t.kubeConfig, t.context, s.kind, s.metadata?.namespace, s.metadata?.name]);
  });
  const step = computed(() => stepFor(rangeSeconds(options.range.value), Math.max(240, options.width.value)));

  let generation = 0;

  /** The Prometheus to query, or null for the metrics-server fallback. */
  async function resolveSource(target: KubeTarget): Promise<UsageSource> {
    const setting = options.setting();
    if (setting?.mode === "off") return { type: "metrics-server", reason: "off" };
    if (setting?.mode === "service") {
      const { namespace, service, port, scheme, pathPrefix } = setting;
      return { type: "prometheus", source: { namespace, service, port, scheme, pathPrefix }, automatic: false };
    }
    const discovery = await discoverCached(target);
    return discovery.found
      ? { type: "prometheus", source: discovery.found.source, automatic: true, kind: discovery.found.kind }
      : { type: "metrics-server", reason: "none" };
  }

  async function load(background = false) {
    const current = ++generation;
    const stale = () => current !== generation;
    const target = options.target();
    const subject = options.subject();
    // A periodic refresh swaps the data in place; other reloads dim the charts meanwhile.
    refreshing.value = !background && !!data.value && source.value?.type === "prometheus";
    if (!refreshing.value && !background) status.value = "loading";

    let resolved: UsageSource;
    try {
      resolved = await resolveSource(target);
    } catch {
      resolved = { type: "metrics-server", reason: "none" };
    }
    if (stale()) return;
    source.value = resolved;
    if (resolved.type === "metrics-server") {
      refreshing.value = false;
      startFallback();
      return;
    }
    stopFallback();

    const query = (from: PromSource) =>
      fetchUsage(target, from, subject, queryWindow(Date.now(), rangeSeconds(options.range.value), step.value));
    try {
      let result: UsageData;
      try {
        result = await query(resolved.source);
      } catch (first) {
        if (!resolved.automatic) throw first;
        // The found API stopped answering: look again (it may have moved).
        forgetDiscovery(target);
        const again = await resolveSource(target);
        if (stale()) return;
        source.value = again;
        if (again.type !== "prometheus") {
          refreshing.value = false;
          startFallback();
          return;
        }
        result = await query(again.source);
      }
      if (stale()) return;
      data.value = result;
      error.value = null;
      status.value = "ready";
    } catch (e) {
      if (stale()) return;
      error.value = toPrometheusError(e, resolved.source);
      status.value = "error";
    } finally {
      if (!stale()) refreshing.value = false;
    }
  }

  /* ------------------------------------------- metrics-server fallback -- */

  let unsubscribe: (() => void) | null = null;
  let fallbackKey = "";
  const histories = new Map<string, Sample[]>();

  const fallbackNamespaces = () => {
    const subject = options.subject();
    const active = options.namespaces();
    if (active.length) return active;
    if (subject.kind === "Node") return [];
    return [subject.kind === "Namespace" ? subject.metadata?.name ?? "" : subject.metadata?.namespace ?? ""].filter(Boolean);
  };

  /* Which metrics-server series belong to the object: "ns/pod" keys or node names. */
  const belongs = (key: string, node: boolean) => {
    const subject = options.subject();
    const scope = scopeOf(subject);
    if (scope.type === "node") return node && key === scope.node;
    if (node) return false;
    const slash = key.indexOf("/");
    const namespace = key.slice(0, slash);
    return (!scope.namespace || namespace === scope.namespace) && matchesPods(scope.pods, key.slice(slash + 1));
  };

  const rebuildFallback = () => {
    data.value = fallbackUsage(options.subject(), [...histories.values()]);
    status.value = "ready";
  };

  const onMetrics = (message: MetricsMessage<PodMetric, NodeMetric>) => {
    if (message.type === "status") {
      fallbackState.value = message.state;
      if (message.state !== "ready" && message.state !== "syncing" && !histories.size) rebuildFallback();
      return;
    }
    if (message.type === "history") {
      const add = (entries: Record<string, MetricsPoint[]>, node: boolean) => {
        for (const [key, points] of Object.entries(entries)) {
          if (belongs(key, node)) histories.set(`${node}:${key}`, points.map(([ts, cpu, memory]) => ({ ts, cpu, memory })));
        }
      };
      add(message.pods, false);
      add(message.nodes, true);
      rebuildFallback();
      return;
    }
    let changed = false;
    const append = (key: string, sample: Sample | null) => {
      if (!sample) return;
      const before = histories.get(key);
      const after = appendSample(before, sample);
      if (after !== before) {
        histories.set(key, after);
        changed = true;
      }
    };
    for (const pod of message.pods) {
      const key = `${pod.metadata?.namespace}/${pod.metadata?.name}`;
      if (belongs(key, false)) append(`false:${key}`, metricSample(pod));
    }
    for (const node of message.nodes) {
      const name = node.metadata?.name ?? "";
      if (!belongs(name, true)) continue;
      const ts = Date.parse(node.timestamp ?? "");
      if (Number.isFinite(ts)) append(`true:${name}`, { ts, cpu: parseCpu(node.usage?.cpu), memory: parseMemory(node.usage?.memory) });
    }
    if (changed) rebuildFallback();
  };

  function startFallback() {
    const target = options.target();
    const namespaces = fallbackNamespaces();
    const key = JSON.stringify([subjectKey.value, namespaces]);
    // Already subscribed (or subscribing) for this object.
    if (key === fallbackKey) return;
    stopFallback();
    fallbackKey = key;
    histories.clear();
    data.value = null;
    error.value = null;
    status.value = "loading";
    fallbackState.value = "syncing";
    const subscription = key;
    subscribeMetrics<PodMetric, NodeMetric>({ kubeConfig: target.kubeConfig ?? "", context: target.context, namespaces }, (message) => {
      if (fallbackKey === subscription) onMetrics(message);
    }).then(
      (stop) => {
        if (fallbackKey === subscription) unsubscribe = stop;
        else stop();
      },
      () => {
        if (fallbackKey !== subscription) return;
        fallbackState.value = "unavailable";
        rebuildFallback();
      }
    );
  }

  function stopFallback() {
    unsubscribe?.();
    unsubscribe = null;
    fallbackKey = "";
  }

  /* ------------------------------------------------------------ wiring -- */

  watch(
    () => [subjectKey.value, options.range.value, step.value, JSON.stringify(options.setting() ?? null)],
    (next, previous) => {
      // A new object: forget the old charts instead of dimming them.
      if (!previous || next[0] !== previous[0]) data.value = null;
      load();
    },
    { immediate: true }
  );

  const visibility = useDocumentVisibility();
  useIntervalFn(() => {
    if (visibility.value === "visible" && source.value?.type === "prometheus" && status.value !== "loading") load(true);
  }, REFRESH_MS);

  onScopeDispose(() => {
    generation++;
    stopFallback();
  });

  return { status, source, data, error, refreshing, fallbackState, reload: () => load() };
}
