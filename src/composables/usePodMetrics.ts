import { onScopeDispose, shallowRef, watch } from "vue";
import {
  MetricsMessage,
  MetricsPoint,
  MetricsState,
  subscribeMetrics,
} from "@/lib/watch";
import type { ContextTarget } from "./useWatchedList";

type TaggedMetric = {
  metadata: { name?: string; namespace?: string; context?: string };
  timestamp?: string;
};

/** `${context}/${namespace}/${name}` - the key rows are joined on. */
export const podMetricKey = (metadata?: {
  context?: string;
  namespace?: string;
  name?: string;
}) => `${metadata?.context}/${metadata?.namespace}/${metadata?.name}`;

interface ContextMetrics {
  unsubscribe: (() => void) | null;
  disposed: boolean;
  state: MetricsState;
  pods: Map<string, TaggedMetric>;
}

/**
 * Live pod metrics (metrics.k8s.io, polled every 15 s by the backend metrics
 * service) for every active context. `metrics` maps podMetricKey -> the
 * latest PodMetric; a metric object is only replaced when metrics-server
 * produced a new sample, so rows joined with it keep their identity.
 * `history` holds the backend's ring buffers ([ms, millicores, bytes]) seeded
 * on subscribe, for trends / sparklines.
 */
export function usePodMetrics(
  targets: () => ContextTarget[],
  enabled: () => boolean = () => true
) {
  const metrics = shallowRef<Map<string, TaggedMetric>>(new Map());
  const history = shallowRef<Map<string, MetricsPoint[]>>(new Map());
  const states = shallowRef<Map<string, MetricsState>>(new Map());
  const contexts = new Map<string, ContextMetrics>();

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

  const onMessage = (
    target: ContextTarget,
    entry: ContextMetrics,
    message: MetricsMessage<TaggedMetric>
  ) => {
    if (entry.disposed) return;
    if (message.type === "status") {
      entry.state = message.state;
      rebuild();
    } else if (message.type === "sample") {
      const next = new Map<string, TaggedMetric>();
      for (const metric of message.pods) {
        const key = podMetricKey(metric.metadata);
        const previous = entry.pods.get(key);
        next.set(
          key,
          previous && previous.timestamp === metric.timestamp ? previous : metric
        );
      }
      entry.pods = next;
      rebuild();
    } else if (message.type === "history") {
      const merged = new Map(history.value);
      for (const [podKey, points] of Object.entries(message.pods)) {
        merged.set(`${target.context}/${podKey}`, points);
      }
      history.value = merged;
    }
  };

  const keyOf = (t: ContextTarget) =>
    JSON.stringify([t.kubeConfig, t.context, [...t.namespaces].sort()]);

  const sync = () => {
    const wanted = new Map<string, ContextTarget>();
    if (enabled()) {
      for (const target of targets()) wanted.set(keyOf(target), target);
    }

    for (const [key, entry] of contexts) {
      if (!wanted.has(key)) {
        entry.disposed = true;
        entry.unsubscribe?.();
        contexts.delete(key);
      }
    }

    for (const [key, target] of wanted) {
      if (contexts.has(key)) continue;
      const entry: ContextMetrics = {
        unsubscribe: null,
        disposed: false,
        state: "syncing",
        pods: new Map(),
      };
      contexts.set(key, entry);
      subscribeMetrics<TaggedMetric>(
        {
          kubeConfig: target.kubeConfig,
          context: target.context,
          namespaces: target.namespaces,
        },
        (message) => onMessage(target, entry, message)
      ).then(
        (unsubscribe) => {
          if (entry.disposed) unsubscribe();
          else entry.unsubscribe = unsubscribe;
        },
        () => {
          // No client for the context: metrics are optional.
          entry.state = "unavailable";
          rebuild();
        }
      );
    }
    rebuild();
  };

  watch(() => JSON.stringify([enabled(), targets()]), sync, {
    immediate: true,
  });

  onScopeDispose(() => {
    for (const entry of contexts.values()) {
      entry.disposed = true;
      entry.unsubscribe?.();
    }
    contexts.clear();
  });

  return { metrics, history, states };
}
