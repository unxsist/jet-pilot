import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

import {
  ContextTarget,
  Row,
  WATCH_UPGRADE_MIN_MS,
  WatchedListController,
  clearWatchedListCache,
} from "@/composables/useWatchedList";
import type { WatchMessage, WatchRequest, WatchTransport } from "@/lib/watch";

type Pod = Row & { metadata: { uid: string; resourceVersion: string; name: string } };

const pod = (uid: string, rv = "1"): Pod => ({
  metadata: { uid, resourceVersion: rv, name: `pod-${uid}` },
});

const target = (context: string, namespaces = ["all"]): ContextTarget => ({
  context,
  kubeConfig: "/kc",
  namespaces,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** In-memory transport: tests push messages through `emit`. */
function fakeTransport(
  options: {
    fail?: (req: WatchRequest) => boolean;
    /** Messages a warm backend watcher sends before subscribe resolves. */
    warm?: (req: WatchRequest) => WatchMessage<Pod>[];
  } = {}
) {
  const subscribers = new Map<string, (m: WatchMessage<Pod>) => void>();
  const unsubscribed: string[] = [];
  const restarted: string[] = [];
  const transport: WatchTransport = {
    async subscribe<T>(
      request: WatchRequest,
      onMessage: (m: WatchMessage<T>) => void
    ) {
      if (options.fail?.(request)) {
        throw new Error("cannot watch");
      }
      subscribers.set(request.context, onMessage as any);
      for (const message of options.warm?.(request) ?? []) {
        (onMessage as any)(message);
      }
      const scopes = request.namespaces.includes("all")
        ? [""]
        : [...request.namespaces].sort();
      return {
        subscription: { id: 1, scopes, namespaced: true, apiVersion: "v1", kind: "Pod" },
        unsubscribe: () => unsubscribed.push(request.context),
        restart: async () => {
          restarted.push(request.context);
        },
      };
    },
  };
  const emit = (context: string, message: WatchMessage<Pod>) =>
    subscribers.get(context)!(message);
  return { transport, emit, unsubscribed, restarted };
}

function controller(
  transport: WatchTransport,
  overrides: Partial<{
    fallback: (t: ContextTarget) => Promise<Pod[]>;
    forcePolling: boolean;
    onAuthError: (t: ContextTarget, m: string) => Promise<boolean>;
  }> = {}
) {
  const updates = { count: 0 };
  const list = new WatchedListController<Pod>(
    {
      resource: "pods",
      kind: "Pod",
      fallback: overrides.fallback ?? (async () => []),
      fallbackInterval: 60_000,
      forcePolling: overrides.forcePolling ?? false,
      onAuthError: overrides.onAuthError,
      transport,
    },
    () => updates.count++
  );
  return { list, updates };
}

const ready = (scope = ""): WatchMessage<Pod> => ({ type: "status", scope, state: "ready" });

afterEach(() => {
  clearWatchedListCache();
});

describe("WatchedListController", () => {
  test("applies snapshot then deltas, keeping identity of unchanged rows", async () => {
    const { transport, emit } = fakeTransport();
    const { list } = controller(transport);
    list.setTargets([target("a")]);
    await flush();
    expect(list.loading()).toBe(true);

    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1"), pod("2")] });
    expect(list.loading()).toBe(false);
    const first = list.items();
    expect(first.map((p) => p.metadata.uid)).toEqual(["1", "2"]);

    emit("a", {
      type: "delta",
      scope: "",
      added: [pod("3")],
      modified: [pod("2", "2")],
      deleted: ["1"],
    });
    const second = list.items();
    expect(second.map((p) => p.metadata.uid).sort()).toEqual(["2", "3"]);
    expect(second.find((p) => p.metadata.uid === "2")!.metadata.resourceVersion).toBe("2");

    // A re-sent snapshot with unchanged versions keeps the same objects.
    const before = list.items().find((p) => p.metadata.uid === "3");
    emit("a", { type: "snapshot", scope: "", items: [pod("2", "2"), pod("3")] });
    expect(list.items().find((p) => p.metadata.uid === "3")).toBe(before);
    expect(list.lastUpdated()).toBeInstanceOf(Date);
  });

  test("is only loaded once every namespace scope is ready", async () => {
    const { transport, emit } = fakeTransport();
    const { list } = controller(transport);
    list.setTargets([target("a", ["ns1", "ns2"])]);
    await flush();

    emit("a", ready("ns1"));
    emit("a", { type: "snapshot", scope: "ns1", items: [pod("1")] });
    expect(list.loading()).toBe(true);
    emit("a", ready("ns2"));
    emit("a", { type: "snapshot", scope: "ns2", items: [pod("2")] });
    expect(list.loading()).toBe(false);

    // A scope snapshot only replaces the rows of that scope.
    emit("a", { type: "snapshot", scope: "ns1", items: [] });
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["2"]);
  });

  test("falls back to kubectl polling when the watch can't start", async () => {
    const { transport } = fakeTransport({ fail: (r) => r.context === "b" });
    const fallback = vi.fn(async () => [pod("kubectl")]);
    const { list } = controller(transport, { fallback });
    list.setTargets([target("a"), target("b")]);
    await flush();
    await flush();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(list.modes().get("a")).toBe("watch");
    expect(list.modes().get("b")).toBe("poll");
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["kubectl"]);
    list.dispose();
  });

  test("forbidden watches switch to polling for that context", async () => {
    const { transport, emit, unsubscribed } = fakeTransport();
    const fallback = vi.fn(async () => [pod("x")]);
    const { list } = controller(transport, { fallback });
    list.setTargets([target("a")]);
    await flush();

    emit("a", { type: "status", scope: "", state: "forbidden", message: "pods is forbidden", code: 403 });
    await flush();
    expect(unsubscribed).toEqual(["a"]);
    expect(list.modes().get("a")).toBe("poll");
    expect(fallback).toHaveBeenCalled();
    list.dispose();
  });

  test("forcePolling never subscribes", async () => {
    const { transport } = fakeTransport();
    const subscribe = vi.spyOn(transport, "subscribe");
    const { list } = controller(transport, { forcePolling: true, fallback: async () => [pod("1")] });
    list.setTargets([target("a")]);
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(list.items()).toHaveLength(1);
    list.dispose();
  });

  test("errors: fatal when every context failed, warning otherwise", async () => {
    const { transport, emit } = fakeTransport();
    const { list } = controller(transport);
    list.setTargets([target("a"), target("b")]);
    await flush();

    emit("a", { type: "status", scope: "", state: "error", message: "connection refused" });
    expect(list.error()).toEqual({ fatal: false, message: "Failed to load from a: connection refused" });

    emit("b", { type: "status", scope: "", state: "error", message: "timeout" });
    expect(list.error()?.fatal).toBe(true);

    // Recovers by itself once the backend reconnects.
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1")] });
    expect(list.error()?.fatal).toBe(false);
  });

  test("unauthorized is handed to the re-login flow and retry restarts", async () => {
    const { transport, emit, restarted } = fakeTransport();
    const onAuthError = vi.fn(async () => true);
    const { list } = controller(transport, { onAuthError });
    list.setTargets([target("a")]);
    await flush();

    emit("a", {
      type: "status",
      scope: "",
      state: "unauthorized",
      message: "executable aws failed: Error loading SSO Token",
    });
    await flush();
    expect(onAuthError).toHaveBeenCalledWith(
      target("a"),
      "executable aws failed: Error loading SSO Token"
    );
    expect(list.error()).toBeNull();

    list.retry();
    expect(restarted).toEqual(["a"]);
  });

  test("changing the selection only touches changed contexts", async () => {
    const { transport, unsubscribed } = fakeTransport();
    const subscribe = vi.spyOn(transport, "subscribe");
    const { list } = controller(transport);
    list.setTargets([target("a")]);
    list.setTargets([target("a"), target("b")]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    list.setTargets([target("b")]);
    await flush();
    expect(unsubscribed).toEqual(["a"]);
    list.dispose();
  });

  test("navigating back shows cached rows immediately", async () => {
    const { transport, emit } = fakeTransport();
    const first = controller(transport).list;
    first.setTargets([target("a")]);
    await flush();
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1"), pod("2")] });
    first.dispose();

    const second = controller(fakeTransport().transport).list;
    second.setTargets([target("a")]);
    expect(second.loading()).toBe(false);
    expect(second.items().map((p) => p.metadata.uid)).toEqual(["1", "2"]);
    second.dispose();
  });

  test("handles 10k rows with small deltas quickly", async () => {
    const { transport, emit } = fakeTransport();
    const { list } = controller(transport);
    list.setTargets([target("a")]);
    await flush();
    const items = Array.from({ length: 10_000 }, (_, i) => pod(String(i)));
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items });

    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      emit("a", { type: "delta", scope: "", added: [], modified: [pod(String(i), "2")], deleted: [] });
      list.items();
    }
    const perDelta = (performance.now() - started) / 100;
    expect(list.items()).toHaveLength(10_000);
    // Generous bound; typically well below 1 ms per delta + rebuild.
    expect(perDelta).toBeLessThan(20);
    list.dispose();
  });

  test("pausing keeps the rows and resuming resubscribes without replacing them", async () => {
    const { transport, emit, unsubscribed } = fakeTransport();
    const subscribe = vi.spyOn(transport, "subscribe");
    const { list, updates } = controller(transport);
    list.setTargets([target("a")]);
    await flush();
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1"), pod("2")] });
    await flush();
    const rows = list.items();

    list.pause();
    expect(unsubscribed).toEqual(["a"]);
    const published = updates.count;
    // late messages of the dropped subscription are ignored
    emit("a", { type: "delta", scope: "", added: [pod("9")], modified: [], deleted: [] });
    await flush();
    expect(updates.count).toBe(published);
    expect(list.items()).toEqual(rows);

    list.resume();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(list.loading()).toBe(false);
    await flush();
    // warm backend watcher: status + snapshot right away, identity kept
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1"), pod("2", "2")] });
    const after = list.items();
    expect(after[0]).toBe(rows[0]);
    expect(after[1].metadata.resourceVersion).toBe("2");
    list.dispose();
  });

  test("a subscription that resolves after pausing is dropped", async () => {
    const { transport, unsubscribed } = fakeTransport();
    const { list } = controller(transport);
    list.setTargets([target("a")]);
    list.pause();
    await flush();
    expect(unsubscribed).toEqual(["a"]);
    list.dispose();
  });

  test("polling stops while paused and polls right away on resume", async () => {
    const fallback = vi.fn(async () => [pod("1")]);
    const { transport } = fakeTransport();
    const { list } = controller(transport, { forcePolling: true, fallback });
    list.setTargets([target("a")]);
    await flush();
    expect(fallback).toHaveBeenCalledTimes(1);
    list.pause();
    await list.sources.values().next().value!.poll();
    expect(fallback).toHaveBeenCalledTimes(1);
    list.resume();
    await flush();
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(list.items()).toHaveLength(1);
    list.dispose();
  });
});

describe("WatchedListController fallback recovery", () => {
  test("retry after a fallback to polling watches again and drops stale polled rows", async () => {
    let fail = true;
    const { transport, emit } = fakeTransport({ fail: () => fail });
    const fallback = vi.fn(async () => [pod("1"), pod("gone")]);
    const { list } = controller(transport, { fallback });
    list.setTargets([target("a", ["ns1"])]);
    await flush();
    await flush();
    expect(list.modes().get("a")).toBe("poll");
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["1", "gone"]);
    const kept = list.items()[0];

    // e.g. the login completed: watching works now
    fail = false;
    list.retry();
    await flush();
    expect(list.modes().get("a")).toBe("watch");
    // polled rows stay visible until the watch snapshot arrived
    expect(list.items()).toHaveLength(2);
    emit("a", ready("ns1"));
    emit("a", { type: "snapshot", scope: "ns1", items: [pod("1")] });
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["1"]);
    expect(list.items()[0]).toBe(kept);
    list.dispose();
  });

  test("a warm snapshot that arrives before subscribe resolves still drops stale polled rows", async () => {
    let fail = true;
    const { transport } = fakeTransport({
      fail: () => fail,
      warm: () => [ready("ns1"), { type: "snapshot", scope: "ns1", items: [pod("1")] }],
    });
    const { list } = controller(transport, { fallback: async () => [pod("1"), pod("gone")] });
    list.setTargets([target("a", ["ns1"])]);
    await flush();
    await flush();
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["1", "gone"]);

    fail = false;
    list.retry();
    await flush();
    expect(list.modes().get("a")).toBe("watch");
    expect(list.items().map((p) => p.metadata.uid)).toEqual(["1"]);
    list.dispose();
  });

  test("rows cached while polling are reconciled by a namespaced watch", async () => {
    const polling = fakeTransport({ fail: () => true });
    const first = controller(polling.transport, {
      fallback: async () => [pod("1"), pod("deleted")],
    }).list;
    first.setTargets([target("a", ["ns1"])]);
    await flush();
    await flush();
    expect(first.modes().get("a")).toBe("poll");
    first.dispose();

    // Back to the list: the watch works now (e.g. after a re-login).
    const { transport, emit } = fakeTransport();
    const second = controller(transport).list;
    second.setTargets([target("a", ["ns1"])]);
    // cached rows render at once
    expect(second.items().map((p) => p.metadata.uid)).toEqual(["1", "deleted"]);
    await flush();
    emit("a", ready("ns1"));
    emit("a", { type: "snapshot", scope: "ns1", items: [pod("1")] });
    expect(second.items().map((p) => p.metadata.uid)).toEqual(["1"]);
    second.dispose();
  });

  test("rows cached from a namespaced watch are reconciled by polling", async () => {
    const { transport, emit } = fakeTransport();
    const first = controller(transport).list;
    first.setTargets([target("a", ["ns1"])]);
    await flush();
    emit("a", ready("ns1"));
    emit("a", { type: "snapshot", scope: "ns1", items: [pod("1"), pod("deleted")] });
    first.dispose();

    const second = controller(fakeTransport().transport, {
      forcePolling: true,
      fallback: async () => [pod("1")],
    }).list;
    second.setTargets([target("a", ["ns1"])]);
    await flush();
    expect(second.items().map((p) => p.metadata.uid)).toEqual(["1"]);
    second.dispose();
  });

  test("a fallback to polling tries to watch again periodically, with backoff", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const { transport, emit } = fakeTransport({ fail: () => fail });
      const subscribe = vi.spyOn(transport, "subscribe");
      const { list } = controller(transport, { fallback: async () => [pod("1")] });
      list.setTargets([target("a")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(list.modes().get("a")).toBe("poll");
      expect(subscribe).toHaveBeenCalledTimes(1);

      // Still failing after a minute: back to polling, next try in 2 min.
      await vi.advanceTimersByTimeAsync(WATCH_UPGRADE_MIN_MS);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(list.modes().get("a")).toBe("poll");
      await vi.advanceTimersByTimeAsync(WATCH_UPGRADE_MIN_MS);
      expect(subscribe).toHaveBeenCalledTimes(2);

      fail = false;
      await vi.advanceTimersByTimeAsync(WATCH_UPGRADE_MIN_MS);
      expect(subscribe).toHaveBeenCalledTimes(3);
      expect(list.modes().get("a")).toBe("watch");
      emit("a", ready());
      emit("a", { type: "snapshot", scope: "", items: [pod("1")] });
      expect(list.items()).toHaveLength(1);

      // Watching: no more attempts.
      await vi.advanceTimersByTimeAsync(10 * WATCH_UPGRADE_MIN_MS);
      expect(subscribe).toHaveBeenCalledTimes(3);
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("forced polling keeps polling on retry", async () => {
    const fallback = vi.fn(async () => [pod("1")]);
    const { transport } = fakeTransport();
    const subscribe = vi.spyOn(transport, "subscribe");
    const { list } = controller(transport, { forcePolling: true, fallback });
    list.setTargets([target("a")]);
    await flush();
    list.retry();
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(2);
    list.dispose();
  });
});

describe("useWatchedList in a kept-alive view", () => {
  test("unsubscribes while hidden, applies selection changes on activation", async () => {
    const { createApp, effectScope, ref, nextTick } = await import("vue");
    const { IsActiveViewKey } = await import("@/lib/activeView");
    const { useWatchedList } = await import("@/composables/useWatchedList");
    const { transport, emit, unsubscribed } = fakeTransport();
    const subscribe = vi.spyOn(transport, "subscribe");
    const active = ref(true);
    const selection = ref([target("a")]);
    const app = createApp({});
    app.provide(IsActiveViewKey, active);
    const scope = effectScope();
    const list = app.runWithContext(() =>
      scope.run(() =>
        useWatchedList<Pod>({
          resource: () => "pods",
          targets: () => selection.value,
          fallback: async () => [],
          transport,
        })
      )
    )!;
    await flush();
    emit("a", ready());
    emit("a", { type: "snapshot", scope: "", items: [pod("1")] });
    await flush();
    expect(list.items.value).toHaveLength(1);

    active.value = false;
    await nextTick();
    expect(unsubscribed).toEqual(["a"]);
    selection.value = [target("a"), target("b")];
    await nextTick();
    expect(subscribe).toHaveBeenCalledTimes(1);

    active.value = true;
    await nextTick();
    await flush();
    expect(list.items.value).toHaveLength(1);
    expect(subscribe.mock.calls.map(([request]) => request.context)).toEqual([
      "a",
      "a",
      "b",
    ]);
    scope.stop();
  });
});
