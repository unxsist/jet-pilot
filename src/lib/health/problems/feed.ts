/*
 * The live Problems list of the active clusters, shared by everything that
 * shows it (the Problems tab, its side panel, the counts on the Health
 * tab and in the sidebar): one set of watches, however many views.
 *
 * Frugal by design. Six kinds are watched per context: pods, Deployments,
 * Jobs, CronJobs, nodes and claims. Owners come from the pods' own
 * references (no ReplicaSet, StatefulSet or DaemonSet lists), warning
 * events only while the Problems tab is open (they add detail, never a
 * problem), and a kind the user may not list isn't watched at all: no
 * forbidden watch falling back to kubectl polling in the background. The
 * watches are the app's shared ones (WatchHub), so the Pods view and this
 * feed watch pods once.
 *
 * The feed starts with its first user and stops with its last one; it only
 * ever looks at the active contexts and never starts a sign-in.
 */
import { computed, effectScope, getCurrentInstance, onScopeDispose, ref, shallowRef, watch, type App, type EffectScope } from "vue";
import { useWatchedList, type ContextTarget } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { runtimeSettings } from "@/lib/settings/runtime";
import { canI } from "@/lib/accessReview";
import { runLimited } from "@/lib/discovery";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { detectProblems, fingerprintScope } from "./group";
import { partition } from "./snooze";
import type { Problem, Ref } from "./model";

interface WatchedKind {
  key: "pods" | "deployments" | "jobs" | "cronJobs" | "nodes" | "claims" | "events";
  kind: string;
  group: string;
  plural: string;
  namespaced: boolean;
}

const kind = (key: WatchedKind["key"], kindName: string, group: string, plural: string, namespaced = true): WatchedKind => ({
  key,
  kind: kindName,
  group,
  plural,
  namespaced,
});

const WATCHED = [
  kind("pods", "Pod", "", "pods"),
  kind("deployments", "Deployment", "apps", "deployments"),
  kind("jobs", "Job", "batch", "jobs"),
  kind("cronJobs", "CronJob", "batch", "cronjobs"),
  kind("nodes", "Node", "", "nodes", false),
  kind("claims", "PersistentVolumeClaim", "", "persistentvolumeclaims"),
];
const EVENTS = kind("events", "Event", "", "events");

const resourceOf = (watched: WatchedKind) => (watched.group ? `${watched.plural}.${watched.group}` : watched.plural);
const targetKey = (target: { context: string; kubeConfig: string }) => `${target.kubeConfig}\u0000${target.context}`;

/* Relative wording (stuck for how long, crashed how recently) stays current. */
const TICK_MS = 30_000;
const ACCESS_CONCURRENCY = 6;

/*
 * Whether `list` is allowed, per context, kind and namespace, for the
 * session (permissions rarely change). null: the question couldn't be
 * asked, so the watch is tried and reports what's wrong itself.
 */
const access = new Map<string, Promise<boolean | null>>();
function mayList(target: ContextTarget, watched: WatchedKind, namespace?: string): Promise<boolean | null> {
  const key = [targetKey(target), watched.group, watched.plural, namespace ?? ""].join("\u0000");
  let answer = access.get(key);
  if (!answer) {
    answer = canI(
      { context: target.context, kubeConfig: target.kubeConfig || undefined },
      { verb: "list", group: watched.group, resource: watched.plural, namespace }
    ).then(
      (decision) => decision.allowed,
      () => null
    );
    access.set(key, answer);
  }
  return answer;
}

/** The namespaces of `target` in which `watched` may be listed (["all"]: everywhere). */
async function readableScope(target: ContextTarget, watched: WatchedKind): Promise<string[]> {
  if (!watched.namespaced || target.namespaces.includes("all")) {
    return (await mayList(target, watched)) === false ? [] : ["all"];
  }
  const answers = await runLimited(
    target.namespaces.map((namespace) => () => mayList(target, watched, namespace)),
    ACCESS_CONCURRENCY
  );
  return target.namespaces.filter((_, index) => {
    const answer = answers[index]!;
    return answer.status !== "fulfilled" || answer.value !== false;
  });
}

function createFeed() {
  const targets = shallowRef<ContextTarget[]>([]);
  const eventUsers = ref(0);

  /* Where each kind is watched, per context: key `${context}|${kind}`. */
  const scopes = shallowRef(new Map<string, string[]>());
  const checking = ref(false);
  const checks = ref(0);
  let generation = 0;
  watch(
    () => [JSON.stringify(targets.value), checks.value],
    async () => {
      const current = ++generation;
      checking.value = true;
      const next = new Map<string, string[]>();
      await Promise.all(
        targets.value.flatMap((target) =>
          [...WATCHED, EVENTS].map(async (watched) => {
            next.set(`${targetKey(target)}|${watched.key}`, await readableScope(target, watched));
          })
        )
      );
      if (current !== generation) return;
      scopes.value = next;
      checking.value = false;
    },
    { immediate: true }
  );

  const list = (watched: WatchedKind, enabled: () => boolean = () => true) => ({
    watched,
    ...useWatchedList<any>({
      resource: () => (enabled() ? resourceOf(watched) : ""),
      kind: () => watched.kind,
      targets: () =>
        targets.value.flatMap((target) => {
          const namespaces = scopes.value.get(`${targetKey(target)}|${watched.key}`);
          return namespaces?.length ? [{ ...target, namespaces }] : [];
        }),
      fallback: (resource, target) => kubectlGetForContext<any>(resource, target.context, target.kubeConfig, target.namespaces),
      forcePolling: () => kubectlPollingForced(runtimeSettings()),
    }),
  });
  const lists = WATCHED.map((watched) => list(watched));
  const events = list(EVENTS, () => eventUsers.value > 0);
  const items = (key: WatchedKind["key"]) => lists.find((l) => l.watched.key === key)!.items.value;

  const now = ref(Date.now());
  const timer = setInterval(() => (now.value = Date.now()), TICK_MS);
  onScopeDispose(() => clearInterval(timer));

  /* When each problem was first seen this session: a start time the cluster doesn't give. */
  const observed = new Map<string, number>();
  const firstObserved = (fingerprint: string) => {
    if (!observed.has(fingerprint)) observed.set(fingerprint, Date.now());
    return observed.get(fingerprint);
  };

  /*
   * Problems that didn't change keep their identity, so their rows don't
   * re-render on every pod update elsewhere in the cluster.
   */
  let previous = new Map<string, { signature: string; problem: Problem }>();
  const stable = (next: Problem[]) => {
    const kept = new Map<string, { signature: string; problem: Problem }>();
    const result = next.map((problem) => {
      const signature = JSON.stringify(problem);
      const known = previous.get(problem.fingerprint);
      const same = known && known.signature === signature ? known.problem : problem;
      kept.set(problem.fingerprint, { signature, problem: same });
      return same;
    });
    previous = kept;
    return result;
  };

  const problems = computed<Problem[]>(() =>
    stable(detectProblems(
      {
        pods: items("pods"),
        deployments: items("deployments"),
        jobs: items("jobs"),
        cronJobs: items("cronJobs"),
        nodes: items("nodes"),
        claims: items("claims"),
        events: eventUsers.value > 0 ? events.items.value : undefined,
      },
      now.value,
      firstObserved
    ))
  );

  /* Lists that couldn't load (unreachable, forbidden), per kind. */
  const errors = computed(() =>
    lists.filter((l) => l.error.value).map((l) => ({ kind: l.watched.kind, message: l.error.value!.message }))
  );

  /* The first snapshot of every list is in. */
  const loading = computed(() => checking.value || lists.some((l) => l.loading.value && l.items.value.length === 0));

  /** Whether a problem with this fingerprint would be listed now (its cluster loaded, its namespace selected). */
  const watches = (fingerprint: string) => {
    const scope = fingerprintScope(fingerprint);
    const target = targets.value.find((t) => t.context === scope.context && t.kubeConfig === scope.kubeConfig);
    if (!target || loading.value) return false;
    return !scope.namespace || target.namespaces.includes("all") || target.namespaces.includes(scope.namespace);
  };

  /** The live object of a reference (any watched kind but events), from the lists at hand. */
  const find = (ref: Ref, context: string) => {
    const watched = WATCHED.find((w) => w.kind === ref.kind);
    if (!watched) return undefined;
    return items(watched.key).find(
      (o) =>
        o.metadata?.context === context &&
        (ref.uid ? o.metadata?.uid === ref.uid : o.metadata?.name === ref.name && (o.metadata?.namespace || undefined) === ref.namespace)
    );
  };

  return {
    targets,
    eventUsers,
    problems,
    items,
    find,
    errors,
    loading,
    now,
    watches,
    retry: () => {
      access.clear();
      checks.value++;
      [...lists, events].forEach((l) => l.retry());
    },
  };
}

export type ProblemFeed = ReturnType<typeof createFeed>;

let shared: { scope: EffectScope; feed: ProblemFeed; users: number } | null = null;

/**
 * The shared feed, for a component's setup: it starts with the first user
 * and stops when the last one unmounts. `targets` (the active contexts)
 * keeps it pointed at the right clusters; `events` asks for the detail
 * warning events add while this user is mounted.
 */
export function useProblemFeed(options: { targets?: () => ContextTarget[]; events?: boolean } = {}): ProblemFeed {
  if (!shared) {
    // Detached from the first user, with the app's context (useWatchedList injects).
    const app: App | undefined = getCurrentInstance()?.appContext.app;
    const scope = effectScope(true);
    const feed = (app ? app.runWithContext(() => scope.run(createFeed)) : scope.run(createFeed))!;
    shared = { scope, feed, users: 0 };
  }
  const current = shared;
  current.users++;
  const { feed } = current;
  if (options.targets) {
    watch(
      () => JSON.stringify(options.targets!()),
      () => (feed.targets.value = options.targets!()),
      { immediate: true }
    );
  }
  if (options.events) feed.eventUsers.value++;
  onScopeDispose(() => {
    if (options.events) feed.eventUsers.value--;
    if (--current.users === 0 && shared === current) {
      current.scope.stop();
      shared = null;
    }
  });
  return feed;
}

/**
 * The problems that aren't snoozed, counted, and whether one of them is
 * severe: the calm count on the Health tab and in the sidebar.
 */
export function useProblemCount(targets?: () => ContextTarget[]) {
  const feed = useProblemFeed({ targets });
  const { settings } = injectStrict(SettingsContextStateKey);
  const open = computed(() =>
    feed.loading.value ? [] : partition(feed.problems.value, settings.value.snoozedProblems ?? [], feed.now.value).open
  );
  return {
    count: computed(() => open.value.length),
    tone: computed(() => (open.value.some((p) => p.tone === "destructive") ? ("destructive" as const) : ("warning" as const))),
  };
}
