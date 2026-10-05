import { onScopeDispose, shallowRef, watch } from "vue";
import {
  MetricsMessage,
  MetricsPoint,
  MetricsState,
  subscribeMetrics,
} from "@/lib/watch";
import { useIsActiveView } from "@/lib/activeView";
import {
  MetricsSample,
  parseCpu,
  parseMemory,
} from "@/components/tables/metrics";
import type { ContextTarget } from "./useWatchedList";

type TaggedMetric = {
  metadata: { name?: string; namespace?: string; context?: string };
  timestamp?: string;
  containers?: { usage?: { cpu?: string; memory?: string } }[];
};

/** `${context}/${namespace}/${name}` - the key rows are joined on. */
export const podMetricKey = (metadata?: {
  context?: string;
  namespace?: string;
  name?: string;
}) => `${metadata?.context}/${metadata?.namespace}/${metadata?.name}`;

/* The context of a podMetricKey (contexts may contain "/", names can't). */
const contextOfKey = (key: string) =>
  key.slice(0, key.lastIndexOf("/", key.lastIndexOf("/") - 1));

/** Samples kept per pod (the backend ring buffers hold as many). */
export const HISTORY_LENGTH = 60;

interface ContextMetrics {
  target: ContextTarget;
  unsubscribe: (() => void) | null;
  /** Bumped per (re)subscribe; messages of older subscriptions are dropped. */
  generation: number;
  disposed: boolean;
  state: MetricsState;
  pods: Map<string, TaggedMetric>;
}

/** One PodMetric as a sample (sum of its containers). */
export function metricSample(metric: TaggedMetric): MetricsSample | null {
  const ts = metric.timestamp ? Date.parse(metric.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  let cpu = 0;
  let memory = 0;
  for (const container of metric.containers || []) {
    cpu += parseCpu(container.usage?.cpu);
    memory += parseMemory(container.usage?.memory);
  }
  return { ts, cpu, memory };
}

const pointToSample = ([ts, cpu, memory]: MetricsPoint): MetricsSample => ({
  ts,
  cpu,
  memory,
});

/**
 * Appends `sample` to `history` (oldest first, at most HISTORY_LENGTH):
 * returns a new array, or the same one when the sample is not newer.
 */
export function appendSample(
  history: MetricsSample[] | undefined,
  sample: MetricsSample
): MetricsSample[] {
  if (!history || history.length === 0) return [sample];
  if (history[history.length - 1].ts >= sample.ts) return history;
  const next = history.slice(-(HISTORY_LENGTH - 1));
  next.push(sample);
  return next;
}

/**
 * Live pod metrics (metrics.k8s.io, polled every 15 s by the backend metrics
 * service) for every active context.
 *
 * - `metrics` maps podMetricKey -> the latest PodMetric; a metric object is
 *   only replaced when metrics-server produced a new sample, so rows joined
 *   with it keep their identity.
 * - `history` maps podMetricKey -> usage samples, oldest first: seeded from
 *   the backend's ring buffers on subscribe and appended to on every new
 *   sample. Arrays are replaced (never mutated) when they change.
 *
 * Hidden kept-alive views unsubscribe (the backend keeps pollers warm for
 * 60 s and replays the last sample + history on resubscribe) and keep the
 * last values meanwhile.
 */
export function usePodMetrics(
  targets: () => ContextTarget[],
  enabled: () => boolean = () => true
) {
  const metrics = shallowRef<Map<string, TaggedMetric>>(new Map());
  const history = shallowRef<Map<string, MetricsSample[]>>(new Map());
  const states = shallowRef<Map<string, MetricsState>>(new Map());
  const contexts = new Map<string, ContextMetrics>();
  const active = useIsActiveView();

  const rebuild = () => {
    const merged = new Map<string, TaggedMetric>();
    for (const entry of contexts.values()) {
      for (const [key, metric] of entry.pods) merged.set(key, metric);
    }
    metrics.value = merged;
    states.value = new Map(
      [...contexts.entries()].map(([key, entry]) => [key, entry.state])
    );
  };

  /* Drops the history of pods of `context` that are not in `keep`. */
  const pruneHistory = (
    merged: Map<string, MetricsSample[]>,
    context: string,
    keep: Set<string>
  ) => {
    for (const key of merged.keys()) {
      if (!keep.has(key) && contextOfKey(key) === context) merged.delete(key);
    }
  };

  const onSample = (entry: ContextMetrics, pods: TaggedMetric[]) => {
    const next = new Map<string, TaggedMetric>();
    const merged = new Map(history.value);
    let historyChanged = false;
    for (const metric of pods) {
      const key = podMetricKey(metric.metadata);
      const previous = entry.pods.get(key);
      const same = previous && previous.timestamp === metric.timestamp;
      next.set(key, same ? previous : metric);
      if (same) continue;
      const sample = metricSample(metric);
      if (!sample) continue;
      const before = merged.get(key);
      const after = appendSample(before, sample);
      if (after !== before) {
        merged.set(key, after);
        historyChanged = true;
      }
    }
    const sizeBefore = merged.size;
    pruneHistory(merged, entry.target.context, new Set(next.keys()));
    if (historyChanged || merged.size !== sizeBefore) history.value = merged;
    entry.pods = next;
    rebuild();
  };

  const onHistory = (
    entry: ContextMetrics,
    pods: Record<string, MetricsPoint[]>
  ) => {
    const merged = new Map(history.value);
    for (const [podKey, points] of Object.entries(pods)) {
      if (!points.length) continue;
      const key = `${entry.target.context}/${podKey}`;
      const current = merged.get(key);
      const last = points[points.length - 1][0];
      // Unchanged (e.g. replayed after resubscribing): keep the array.
      if (
        current &&
        current.length === points.length &&
        current[current.length - 1].ts === last
      ) {
        continue;
      }
      merged.set(key, points.map(pointToSample));
    }
    history.value = merged;
  };

  const onMessage = (
    entry: ContextMetrics,
    generation: number,
    message: MetricsMessage<TaggedMetric>
  ) => {
    if (entry.disposed || entry.generation !== generation) return;
    if (message.type === "status") {
      entry.state = message.state;
      rebuild();
    } else if (message.type === "sample") {
      onSample(entry, message.pods);
    } else if (message.type === "history") {
      onHistory(entry, message.pods);
    }
  };

  const subscribe = (entry: ContextMetrics) => {
    const generation = ++entry.generation;
    const { target } = entry;
    subscribeMetrics<TaggedMetric>(
      {
        kubeConfig: target.kubeConfig,
        context: target.context,
        namespaces: target.namespaces,
      },
      (message) => onMessage(entry, generation, message)
    ).then(
      (unsubscribe) => {
        if (entry.disposed || entry.generation !== generation) unsubscribe();
        else entry.unsubscribe = unsubscribe;
      },
      () => {
        if (entry.disposed || entry.generation !== generation) return;
        // No client for the context: metrics are optional.
        entry.state = "unavailable";
        rebuild();
      }
    );
  };

  const unsubscribe = (entry: ContextMetrics) => {
    entry.generation++;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
  };

  const keyOf = (t: ContextTarget) =>
    JSON.stringify([t.kubeConfig, t.context, [...t.namespaces].sort()]);

  const sync = () => {
    const wanted = new Map<string, ContextTarget>();
    if (enabled()) {
      for (const target of targets()) wanted.set(keyOf(target), target);
    }

    let removed = false;
    for (const [key, entry] of contexts) {
      if (!wanted.has(key)) {
        entry.disposed = true;
        unsubscribe(entry);
        contexts.delete(key);
        removed = true;
      }
    }
    if (removed) {
      const contextsLeft = new Set(
        [...contexts.values()].map((e) => e.target.context)
      );
      const merged = new Map(
        [...history.value].filter(([key]) => contextsLeft.has(contextOfKey(key)))
      );
      if (merged.size !== history.value.size) history.value = merged;
    }

    for (const [key, target] of wanted) {
      if (contexts.has(key)) continue;
      const entry: ContextMetrics = {
        target,
        unsubscribe: null,
        generation: 0,
        disposed: false,
        state: "syncing",
        pods: new Map(),
      };
      contexts.set(key, entry);
      subscribe(entry);
    }
    rebuild();
  };

  // While the view is hidden the subscriptions are dropped and the target
  // selection is synced on activation.
  let stale = false;
  watch(
    () => JSON.stringify([enabled(), targets()]),
    () => {
      if (active.value) sync();
      else stale = true;
    }
  );
  if (active.value) sync();
  else stale = true;

  watch(active, (isActive) => {
    if (!isActive) {
      for (const entry of contexts.values()) unsubscribe(entry);
      return;
    }
    for (const entry of contexts.values()) {
      if (!entry.unsubscribe) subscribe(entry);
    }
    if (stale) {
      stale = false;
      sync();
    }
  });

  onScopeDispose(() => {
    for (const entry of contexts.values()) {
      entry.disposed = true;
      unsubscribe(entry);
    }
    contexts.clear();
  });

  return { metrics, history, states };
}
