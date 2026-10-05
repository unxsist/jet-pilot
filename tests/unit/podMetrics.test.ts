import { describe, expect, test, vi } from "vitest";
import type { MetricsMessage, MetricsRequest } from "@/lib/watch";

type OnMessage = (message: MetricsMessage) => void;

const subscriptions: {
  context: string;
  onMessage: OnMessage;
  unsubscribed: boolean;
}[] = [];

vi.mock("@/lib/watch", () => ({
  subscribeMetrics: vi.fn(async (request: MetricsRequest, onMessage: OnMessage) => {
    const entry = { context: request.context, onMessage, unsubscribed: false };
    subscriptions.push(entry);
    return () => (entry.unsubscribed = true);
  }),
}));

import { createApp, effectScope, nextTick, ref } from "vue";
import { IsActiveViewKey } from "@/lib/activeView";
import {
  HISTORY_LENGTH,
  appendSample,
  metricSample,
  usePodMetrics,
} from "@/composables/usePodMetrics";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const metric = (name: string, ts: number, cpu = "100m", memory = "64Mi") => ({
  metadata: { name, namespace: "ns", context: "ctx" },
  timestamp: new Date(ts).toISOString(),
  containers: [{ usage: { cpu, memory } }, { usage: { cpu: "50m", memory: "1Mi" } }],
});

describe("metric samples", () => {
  test("a PodMetric sums its containers", () => {
    expect(metricSample(metric("a", 1000))).toEqual({
      ts: 1000,
      cpu: 150,
      memory: 65 * 1024 * 1024,
    });
    expect(metricSample({ metadata: {} })).toBeNull();
  });

  test("appending returns a new bounded array, oldest first", () => {
    const one = appendSample(undefined, { ts: 1, cpu: 1, memory: 1 });
    const two = appendSample(one, { ts: 2, cpu: 2, memory: 2 });
    expect(two).not.toBe(one);
    expect(one).toHaveLength(1);
    expect(two.map((s) => s.ts)).toEqual([1, 2]);
    // the same scrape again changes nothing
    expect(appendSample(two, { ts: 2, cpu: 9, memory: 9 })).toBe(two);

    let history = two;
    for (let ts = 3; ts < HISTORY_LENGTH + 10; ts++) {
      history = appendSample(history, { ts, cpu: ts, memory: ts });
    }
    expect(history).toHaveLength(HISTORY_LENGTH);
    expect(history[history.length - 1].ts).toBe(HISTORY_LENGTH + 9);
  });
});

describe("usePodMetrics", () => {
  test("history is seeded, appended per sample and kept while the view is hidden", async () => {
    subscriptions.length = 0;
    const active = ref(true);
    const app = createApp({});
    app.provide(IsActiveViewKey, active);
    const scope = effectScope();
    const { metrics, history } = app.runWithContext(() =>
      scope.run(() =>
        usePodMetrics(() => [
          { context: "ctx", kubeConfig: "/kc", namespaces: ["all"] },
        ])
      )
    )!;
    await flush();
    expect(subscriptions).toHaveLength(1);
    const send = (message: MetricsMessage) =>
      subscriptions[subscriptions.length - 1].onMessage(message);

    send({ type: "status", state: "ready" });
    send({ type: "sample", timestamp: 2000, pods: [metric("a", 2000)], nodes: [] });
    send({
      type: "history",
      pods: { "ns/a": [[1000, 10, 100], [2000, 150, 200]] },
      nodes: {},
    });
    const seeded = history.value.get("ctx/ns/a")!;
    expect(seeded.map((s) => s.ts)).toEqual([1000, 2000]);
    expect(metrics.value.get("ctx/ns/a")).toBeDefined();

    send({ type: "sample", timestamp: 3000, pods: [metric("a", 3000)], nodes: [] });
    const appended = history.value.get("ctx/ns/a")!;
    expect(appended).not.toBe(seeded);
    expect(appended.map((s) => s.ts)).toEqual([1000, 2000, 3000]);
    expect(appended[2].cpu).toBe(150);

    // hidden: unsubscribed, values kept
    active.value = false;
    await nextTick();
    expect(subscriptions[0].unsubscribed).toBe(true);
    expect(history.value.get("ctx/ns/a")).toBe(appended);
    expect(metrics.value.get("ctx/ns/a")).toBeDefined();

    // shown again: resubscribed; the replayed history keeps the array
    active.value = true;
    await nextTick();
    await flush();
    expect(subscriptions).toHaveLength(2);
    send({ type: "status", state: "ready" });
    send({ type: "sample", timestamp: 3000, pods: [metric("a", 3000)], nodes: [] });
    send({
      type: "history",
      pods: { "ns/a": [[1000, 10, 100], [2000, 150, 200], [3000, 150, 300]] },
      nodes: {},
    });
    expect(history.value.get("ctx/ns/a")).toBe(appended);

    // a deleted pod drops its history
    send({ type: "sample", timestamp: 4000, pods: [], nodes: [] });
    expect(history.value.has("ctx/ns/a")).toBe(false);
    scope.stop();
    expect(subscriptions[1].unsubscribed).toBe(true);
  });
});
