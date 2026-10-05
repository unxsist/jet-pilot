import {
  markRaw,
  nextTick,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
} from "vue";
import {
  ContextFailure,
  ResourceListError,
  describeFailures,
} from "./useResourceList";
import {
  WatchHandle,
  WatchMessage,
  WatchStatusMessage,
  WatchTransport,
  tauriWatchTransport,
} from "@/lib/watch";
import { error as logError, log as logInfo } from "@/lib/logger";
import { useIsActiveView } from "@/lib/activeView";
import { markFirstData } from "@/lib/perf";

/** One activated context and the namespaces selected for it. */
export interface ContextTarget {
  context: string;
  kubeConfig: string;
  /** ["all"] = all namespaces. */
  namespaces: string[];
}

export type Row = {
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    resourceVersion?: string;
  };
};

export type SourceMode = "watch" | "poll";

export interface WatchedListOptions<T> {
  /** kubectl resource name (`pods`, `deployments`, CRD plurals, ...). */
  resource: string;
  kind?: string;
  /** kubectl polling for one context: the fallback path. */
  fallback: (target: ContextTarget) => Promise<T[]>;
  fallbackInterval: number;
  /** Use kubectl polling for every context (setting / harness flag). */
  forcePolling: boolean;
  /**
   * Offer a re-login for an authentication failure. Resolves true when it is
   * being handled, which keeps the failure out of the error banner.
   */
  onAuthError?: (target: ContextTarget, message: string) => Promise<boolean>;
  transport: WatchTransport;
  /** Called (coalesced) whenever rows or state changed. */
  onChange: () => void;
}

const CACHE_TTL_MS = 60_000;
/*
 * A context that fell back to polling tries to watch again after this long,
 * doubling up to the maximum while it keeps failing.
 */
export const WATCH_UPGRADE_MIN_MS = 60_000;
export const WATCH_UPGRADE_MAX_MS = 10 * 60_000;
const MAX_PUBLISH_GAP_MS = 5000;
const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
const CACHE_MAX_ENTRIES = 24;
const TERMINAL: WatchStatusMessage["state"][] = [
  "forbidden",
  "unauthorized",
  "failed",
];

interface CachedRows {
  rows: Map<string, unknown>;
  scopeOf: Map<string, string>;
  /** How the rows were obtained: polled rows all have scope "". */
  mode: SourceMode;
  at: number;
}

/*
 * Rows of recently left lists, so navigating back renders instantly (the
 * backend keeps the watchers warm for the same period and sends a fresh
 * snapshot right after, reconciled without replacing unchanged rows).
 */
const rowCache = new Map<string, CachedRows>();

export function clearWatchedListCache() {
  rowCache.clear();
}

function cacheKey(resource: string, kind: string | undefined, t: ContextTarget) {
  return JSON.stringify([
    resource,
    kind ?? "",
    t.kubeConfig,
    t.context,
    [...t.namespaces].sort(),
  ]);
}

const uidOf = (row: Row) =>
  row.metadata?.uid ?? `${row.metadata?.namespace ?? ""}/${row.metadata?.name}`;

const sameVersion = (a: Row, b: Row) =>
  !!a.metadata?.resourceVersion &&
  a.metadata.resourceVersion === b.metadata?.resourceVersion;

const reasonToString = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const documentHidden = () =>
  typeof document !== "undefined" && document.hidden;

/**
 * The rows of one context: from a backend watch, or (fallback) from kubectl
 * polling. Either way rows live in a Map keyed by uid and unchanged rows keep
 * their object identity across updates.
 */
export class ContextSource<T extends Row> {
  mode: SourceMode;
  rows = new Map<string, T>();
  /** uid -> scope (namespace watcher) the row came from. */
  scopeOf = new Map<string, string>();
  scopes: string[] | null = null;
  scopeStatus = new Map<string, WatchStatusMessage>();
  loaded = false;
  failure: unknown = null;
  authHandled = false;
  lastChange: Date | null = null;
  pollingStopped = false;

  private handle: WatchHandle | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private disposed = false;
  /** The view is hidden (kept alive): no subscription, no polling. */
  private paused = false;
  /** Bumped on every (re)subscribe, so a stale in-flight one is dropped. */
  private subscribeGeneration = 0;
  private pollGeneration = 0;
  private authPending = false;

  constructor(
    readonly key: string,
    readonly target: ContextTarget,
    private readonly options: WatchedListOptions<T>
  ) {
    this.mode = options.forcePolling ? "poll" : "watch";

    const cached = rowCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      this.rows = new Map(cached.rows as Map<string, T>);
      this.scopeOf = new Map(cached.scopeOf);
      this.loaded = true;
      // Polling reconciles scope "" only: let the first poll confirm rows
      // that a watch cached under namespace scopes. (Watching reconciles
      // any cached scope, see reconcileScopes.)
      if (this.mode === "poll" && cached.mode !== "poll") {
        for (const uid of this.scopeOf.keys()) this.scopeOf.set(uid, "");
      }
    }
  }

  start() {
    if (this.paused) return;
    if (this.mode === "watch") {
      this.subscribe();
    } else {
      this.startPolling();
    }
  }

  /**
   * The view was hidden: stop receiving updates but keep the rows. The
   * backend keeps the watchers warm (60 s), so resuming gets a snapshot
   * right away, reconciled without replacing unchanged rows.
   */
  pause() {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.subscribeGeneration++;
    this.handle?.unsubscribe();
    this.handle = null;
    this.stopTimer();
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.start();
  }

  dispose() {
    this.disposed = true;
    this.subscribeGeneration++;
    this.handle?.unsubscribe();
    this.handle = null;
    this.stopTimer();
    this.cancelWatchUpgrade();
    if (this.loaded && !this.failure) {
      rowCache.delete(this.key);
      rowCache.set(this.key, {
        rows: this.rows,
        scopeOf: this.scopeOf,
        mode: this.mode,
        at: Date.now(),
      });
      while (rowCache.size > CACHE_MAX_ENTRIES) {
        rowCache.delete(rowCache.keys().next().value!);
      }
    }
  }

  retry() {
    this.authHandled = false;
    this.pollingStopped = false;
    if (this.paused) return;
    if (this.mode === "watch") {
      this.handle?.restart();
    } else if (!this.options.forcePolling) {
      // Polling only as a fallback (watch couldn't start, forbidden, a
      // failed login): try watching again, e.g. after a re-login.
      this.watchUpgradeDelay = WATCH_UPGRADE_MIN_MS;
      this.switchToWatch();
    } else {
      this.poll();
      this.startTimer();
    }
  }

  /** Called on visibility changes: poll right away when shown again. */
  visibilityChanged() {
    if (this.mode !== "poll" || this.disposed || this.paused) return;
    if (documentHidden()) {
      this.stopTimer();
    } else if (!this.pollingStopped) {
      this.poll();
      this.startTimer();
    }
  }

  private changed() {
    this.lastChange = new Date();
    this.options.onChange();
  }

  /* ------------------------------------------------------------ watch -- */

  private async subscribe() {
    const generation = ++this.subscribeGeneration;
    this.snapshotScopes = new Set();
    const stale = () =>
      this.disposed ||
      this.paused ||
      this.mode !== "watch" ||
      generation !== this.subscribeGeneration;
    try {
      const handle = await this.options.transport.subscribe<T>(
        {
          kubeConfig: this.target.kubeConfig,
          context: this.target.context,
          resource: this.options.resource,
          kind: this.options.kind,
          namespaces: this.target.namespaces,
        },
        (message) => {
          if (generation === this.subscribeGeneration) this.onMessage(message);
        }
      );
      if (stale()) {
        handle.unsubscribe();
        return;
      }
      this.handle = handle;
      this.scopes = handle.subscription.scopes;
      // Warm watchers may have sent their snapshots before this resolved.
      this.reconcileScopes();
      this.updateWatchState();
      this.options.onChange();
    } catch (e) {
      if (stale()) return;
      logInfo(
        `Watch for ${this.options.resource} in ${this.target.context} unavailable, polling with kubectl instead: ${reasonToString(e)}`
      );
      this.switchToPolling();
    }
  }

  private onMessage(message: WatchMessage<T>) {
    if (this.disposed || this.paused || this.mode !== "watch") return;

    switch (message.type) {
      case "snapshot":
        this.applySnapshot(message.scope, message.items);
        this.snapshotScopes.add(message.scope);
        this.reconcileScopes();
        this.watchUpgradeDelay = WATCH_UPGRADE_MIN_MS;
        this.scopeStatus.set(message.scope, {
          type: "status",
          scope: message.scope,
          state: "ready",
        });
        this.updateWatchState();
        this.changed();
        break;
      case "delta":
        for (const row of message.added) this.upsert(message.scope, row);
        for (const row of message.modified) this.upsert(message.scope, row);
        for (const uid of message.deleted) {
          this.rows.delete(uid);
          this.scopeOf.delete(uid);
        }
        this.changed();
        break;
      case "status":
        this.scopeStatus.set(message.scope, message);
        if (message.state === "ready") {
          this.authHandled = false;
        }
        if (message.state === "forbidden") {
          // RBAC may allow `list` without `watch`; kubectl reports the
          // error the same way the polling views always did otherwise.
          logInfo(
            `Watching ${this.options.resource} is forbidden in ${this.target.context}, polling with kubectl instead`
          );
          this.switchToPolling();
          return;
        }
        if (message.state === "unauthorized") {
          this.handleAuth(message.message || "Unauthorized");
        }
        this.updateWatchState();
        this.options.onChange();
        break;
    }
  }

  private upsert(scope: string, row: T) {
    const uid = uidOf(row);
    this.rows.set(uid, markRaw(row));
    this.scopeOf.set(uid, scope);
  }

  /**
   * Replaces the rows of `scope` with `items`, keeping the existing object
   * for rows whose resourceVersion did not change.
   */
  applySnapshot(scope: string, items: T[]) {
    const seen = new Set<string>();
    for (const item of items) {
      const uid = uidOf(item);
      seen.add(uid);
      const previous = this.rows.get(uid);
      if (previous && sameVersion(previous, item)) {
        this.scopeOf.set(uid, scope);
        continue;
      }
      // Rows are immutable snapshots: never make them deeply reactive
      // (thousands of large objects proxied by the table cost seconds).
      this.rows.set(uid, markRaw(item));
      this.scopeOf.set(uid, scope);
    }
    for (const [uid, rowScope] of this.scopeOf) {
      if (rowScope === scope && !seen.has(uid)) {
        this.rows.delete(uid);
        this.scopeOf.delete(uid);
      }
    }
  }

  private updateWatchState() {
    const statuses = [...this.scopeStatus.values()];
    const failed = statuses.find(
      (s) => s.state === "error" || TERMINAL.includes(s.state)
    );
    this.failure =
      failed && !(failed.state === "unauthorized" && this.authHandled)
        ? new Error(failed.message || `Watch ${failed.state}`)
        : null;

    const scopesReady =
      this.scopes !== null &&
      this.scopes.every((scope) => {
        const state = this.scopeStatus.get(scope)?.state;
        return state === "ready" || state === "relisting";
      });
    if (scopesReady || failed) {
      this.loaded = true;
    }
  }

  private async handleAuth(message: string) {
    if (!this.options.onAuthError || this.authPending) return;
    this.authPending = true;
    try {
      this.authHandled = await this.options.onAuthError(this.target, message);
    } catch {
      this.authHandled = false;
    } finally {
      this.authPending = false;
    }
    if (this.mode === "watch") {
      this.updateWatchState();
    } else if (this.authHandled) {
      this.failure = null;
    }
    this.options.onChange();
  }

  /* Scopes that sent a snapshot since the current subscribe started. */
  private snapshotScopes = new Set<string>();

  private switchToWatch() {
    this.stopTimer();
    this.cancelWatchUpgrade();
    this.pollGeneration++;
    this.inFlight = false;
    this.mode = "watch";
    this.failure = null;
    this.scopeStatus.clear();
    this.scopes = null;
    // Polled rows (scope "") stay until every watch scope sent its snapshot.
    this.subscribe();
    this.options.onChange();
  }

  /*
   * Once every scope of the subscription sent its snapshot, rows of any
   * other scope are stale: polled rows (scope ""), or rows restored from the
   * cache under a different scope set. Runs on every snapshot and when the
   * subscription resolves (a warm watcher's snapshot can arrive first).
   */
  private reconcileScopes() {
    const scopes = this.scopes;
    if (!scopes || !scopes.every((s) => this.snapshotScopes.has(s))) return;
    const current = new Set(scopes);
    for (const [uid, rowScope] of this.scopeOf) {
      if (!current.has(rowScope)) {
        this.rows.delete(uid);
        this.scopeOf.delete(uid);
      }
    }
  }

  /* ------------------------------------------- automatic watch upgrade -- */

  private watchUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private watchUpgradeDelay = WATCH_UPGRADE_MIN_MS;

  /*
   * Polling as a fallback (the watch couldn't start or was forbidden) tries
   * to watch again periodically, with backoff while that keeps failing.
   */
  private scheduleWatchUpgrade() {
    this.cancelWatchUpgrade();
    if (this.options.forcePolling || this.disposed) return;
    const delay = this.watchUpgradeDelay;
    this.watchUpgradeDelay = Math.min(delay * 2, WATCH_UPGRADE_MAX_MS);
    this.watchUpgradeTimer = setTimeout(() => {
      this.watchUpgradeTimer = null;
      if (this.disposed || this.mode !== "poll") return;
      if (this.paused || documentHidden()) {
        // Try again once it is shown; don't count this as an attempt.
        this.watchUpgradeDelay = delay;
        this.scheduleWatchUpgrade();
        return;
      }
      logInfo(
        `Trying to watch ${this.options.resource} in ${this.target.context} again`
      );
      this.switchToWatch();
    }, delay);
  }

  private cancelWatchUpgrade() {
    if (this.watchUpgradeTimer !== null) {
      clearTimeout(this.watchUpgradeTimer);
      this.watchUpgradeTimer = null;
    }
  }

  private switchToPolling() {
    if (this.disposed) return;
    this.subscribeGeneration++;
    this.handle?.unsubscribe();
    this.handle = null;
    this.mode = "poll";
    this.failure = null;
    this.scopeStatus.clear();
    this.scopes = null;
    // The first poll reconciles every row.
    for (const uid of this.scopeOf.keys()) this.scopeOf.set(uid, "");
    this.startPolling();
    this.scheduleWatchUpgrade();
    this.options.onChange();
  }

  /* ------------------------------------------------------------- poll -- */

  private startPolling() {
    if (this.paused) return;
    this.poll();
    this.startTimer();
  }

  private startTimer() {
    this.stopTimer();
    if (documentHidden() || this.disposed || this.paused) return;
    this.timer = setInterval(() => {
      if (!this.pollingStopped) this.poll();
    }, this.options.fallbackInterval);
  }

  private stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (this.inFlight || this.disposed || this.paused) return;
    this.inFlight = true;
    const generation = ++this.pollGeneration;
    try {
      const rows = await this.options.fallback(this.target);
      if (this.disposed || generation !== this.pollGeneration) return;
      // Results of a poll that started before the view was hidden are kept
      // (they are current), only further polls are skipped.
      this.applySnapshot("", rows);
      this.failure = null;
      this.authHandled = false;
      this.loaded = true;
      this.changed();
    } catch (e) {
      if (this.disposed || generation !== this.pollGeneration) return;
      logError(
        `Failed to fetch ${this.options.resource} for context ${this.target.context}: ${e}`
      );
      this.failure = e;
      this.loaded = true;
      if (!this.authHandled) {
        this.handleAuth(reasonToString(e));
      }
      this.options.onChange();
    } finally {
      if (generation === this.pollGeneration) this.inFlight = false;
    }
  }
}

/**
 * All active contexts of one resource list. Sources are keyed by
 * (resource, kind, kubeconfig, context, namespaces): changing the context
 * selection only (un)subscribes the contexts that changed.
 */
export class WatchedListController<T extends Row> {
  sources = new Map<string, ContextSource<T>>();
  private order: string[] = [];
  private notifyQueued = false;
  private disposed = false;
  private paused = false;
  /** A change arrived while paused (e.g. a poll that was in flight). */
  private dirty = false;

  constructor(
    private readonly options: Omit<WatchedListOptions<T>, "onChange">,
    private readonly onUpdate: () => void
  ) {}

  private lastPublish = -Infinity;

  /*
   * Coalesces changes into one update of the view. Small lists update on
   * every backend batch (150 ms); large lists at most every rows/5 ms, and
   * never more often than 4x the measured render cost (every update
   * re-runs the table's row models). The first change after a quiet period
   * is published right away.
   */
  private notify = () => {
    if (this.paused) {
      this.dirty = true;
      return;
    }
    if (this.notifyQueued || this.disposed) return;
    this.notifyQueued = true;
    const publish = () => {
      this.notifyQueued = false;
      if (this.paused) {
        this.dirty = true;
        return;
      }
      this.lastPublish = now();
      if (!this.disposed) this.onUpdate();
    };
    const wait = this.lastPublish + this.minPublishGap() - now();
    if (wait <= 0) {
      queueMicrotask(publish);
    } else {
      setTimeout(publish, wait);
    }
  };

  private renderCost = 0;

  /**
   * Reports how long the view took to apply the last update (render
   * included), so slow renders are spread out to keep the UI responsive.
   */
  reportRenderCost(ms: number) {
    // Smoothed, so one slow frame doesn't stall updates for long.
    this.renderCost = this.renderCost * 0.5 + ms * 0.5;
  }

  private minPublishGap() {
    let rows = 0;
    for (const source of this.sources.values()) rows += source.rows.size;
    // At most ~20% of the main thread for live updates.
    return Math.min(
      MAX_PUBLISH_GAP_MS,
      Math.max(rows / 5, this.renderCost * 4)
    );
  }

  setTargets(targets: ContextTarget[]) {
    const next = new Map<string, ContextTarget>();
    for (const target of targets) {
      next.set(cacheKey(this.options.resource, this.options.kind, target), target);
    }

    for (const [key, source] of this.sources) {
      if (!next.has(key)) {
        source.dispose();
        this.sources.delete(key);
      }
    }
    for (const [key, target] of next) {
      if (!this.sources.has(key)) {
        const source = new ContextSource<T>(key, target, {
          ...this.options,
          onChange: this.notify,
        });
        this.sources.set(key, source);
        if (this.paused) source.pause();
        source.start();
      }
    }
    this.order = [...next.keys()];
    this.onUpdate();
  }

  items(): T[] {
    const items: T[] = [];
    for (const key of this.order) {
      const source = this.sources.get(key);
      if (source) for (const row of source.rows.values()) items.push(row);
    }
    return items;
  }

  loading(): boolean {
    return [...this.sources.values()].some((s) => !s.loaded && !s.failure);
  }

  error(): ResourceListError | null {
    const failures: ContextFailure[] = [];
    for (const source of this.sources.values()) {
      if (source.failure && !source.authHandled) {
        failures.push({ context: source.target.context, reason: source.failure });
      }
    }
    const error = describeFailures(failures, this.sources.size);
    // Like the polling views: nothing loads at all -> stop polling until
    // retried (watches keep reconnecting with backoff in the backend and
    // polling resumes as soon as one of them recovers).
    for (const source of this.sources.values()) {
      source.pollingStopped = !!error?.fatal;
    }
    return error;
  }

  lastUpdated(): Date | null {
    let latest: Date | null = null;
    for (const source of this.sources.values()) {
      if (source.lastChange && (!latest || source.lastChange > latest)) {
        latest = source.lastChange;
      }
    }
    return latest;
  }

  modes(): Map<string, SourceMode> {
    return new Map(
      [...this.sources.values()].map((s) => [s.target.context, s.mode])
    );
  }

  retry() {
    for (const source of this.sources.values()) source.retry();
  }

  visibilityChanged() {
    for (const source of this.sources.values()) source.visibilityChanged();
  }

  /**
   * The view was hidden (kept alive): unsubscribe / stop polling, keep the
   * rows, publish nothing until resumed.
   */
  pause() {
    if (this.paused || this.disposed) return;
    this.paused = true;
    for (const source of this.sources.values()) source.pause();
  }

  /** Shown again: re-subscribe (warm watchers send a snapshot at once). */
  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    for (const source of this.sources.values()) source.resume();
    if (this.dirty) {
      this.dirty = false;
      this.onUpdate();
    }
  }

  get isPaused() {
    return this.paused;
  }

  dispose() {
    this.disposed = true;
    for (const source of this.sources.values()) source.dispose();
    this.sources.clear();
  }
}

export interface UseWatchedListOptions<T> {
  resource: () => string;
  kind?: () => string | undefined;
  targets: () => ContextTarget[];
  fallback: (resource: string, target: ContextTarget) => Promise<T[]>;
  /** kubectl polling interval (fallback path), ms. */
  fallbackInterval?: number;
  forcePolling?: () => boolean;
  onAuthError?: (target: ContextTarget, message: string) => Promise<boolean>;
  transport?: WatchTransport;
}

/**
 * Live list of a resource across every active (context, namespaces), backed
 * by the Rust WatchHub with automatic per-context fallback to kubectl
 * polling. Exposes the same contract as `useResourceList` (items, loading,
 * error, lastUpdated, retry) so the table and actions work unchanged.
 */
export function useWatchedList<T extends Row>(options: UseWatchedListOptions<T>) {
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const error = ref<ResourceListError | null>(null);
  const lastUpdated = ref<Date | null>(null);
  const modes = shallowRef<Map<string, SourceMode>>(new Map());

  /*
   * Hidden kept-alive views don't stream (see @/lib/activeView): the
   * controller unsubscribes / stops polling and keeps its rows. Changes of
   * the resource or the context selection while hidden are applied on
   * activation.
   */
  const active = useIsActiveView();
  let staleResource = false;
  let staleTargets = false;

  let controller: WatchedListController<T> | null = null;
  let firstDataMarked = false;

  const update = () => {
    const current = controller;
    if (!current) return;
    const started = now();
    items.value = current.items();
    loading.value = current.loading();
    error.value = current.error();
    lastUpdated.value = current.lastUpdated();
    modes.value = current.modes();
    nextTick(() => {
      current.reportRenderCost(now() - started);
      if (!firstDataMarked && items.value.length > 0) {
        firstDataMarked = true;
        markFirstData();
      }
    });
  };

  const create = () => {
    staleResource = false;
    staleTargets = false;
    controller?.dispose();
    const resource = options.resource();
    if (!resource) {
      controller = null;
      items.value = [];
      return;
    }
    const kind = options.kind?.();
    controller = new WatchedListController<T>(
      {
        resource,
        kind,
        fallback: (target) => options.fallback(resource, target),
        fallbackInterval: options.fallbackInterval ?? 5000,
        forcePolling: options.forcePolling?.() ?? false,
        onAuthError: options.onAuthError,
        transport: options.transport ?? tauriWatchTransport,
      },
      update
    );
    if (!active.value) controller.pause();
    controller.setTargets(options.targets());
  };

  watch(
    () => [options.resource(), options.kind?.(), options.forcePolling?.()],
    () => {
      if (active.value) create();
      else staleResource = true;
    }
  );
  create();

  watch(
    () => JSON.stringify(options.targets()),
    () => {
      if (active.value) controller?.setTargets(options.targets());
      else staleTargets = true;
    }
  );

  watch(active, (isActive) => {
    if (!isActive) {
      controller?.pause();
    } else if (staleResource) {
      create();
    } else {
      controller?.resume();
      if (staleTargets) {
        staleTargets = false;
        controller?.setTargets(options.targets());
      }
    }
  });

  const onVisibilityChange = () => controller?.visibilityChanged();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  onScopeDispose(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    controller?.dispose();
    controller = null;
  });

  return {
    items,
    loading,
    error,
    lastUpdated,
    /** Per context: "watch" (live) or "poll" (kubectl fallback). */
    modes,
    retry: () => controller?.retry(),
    reload: create,
  };
}
