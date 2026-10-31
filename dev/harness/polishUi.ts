/*
 * Fixtures for the tables, logs and rollouts polish: a realistic log tail
 * for the volume histogram (`?scenario=log-volume`), with a quiet baseline,
 * a wave and an incident (timeouts, retries) a few minutes ago; and
 * rollouts that play out, or get stuck, for "Notify me".
 */
import { CLUSTERS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";

/* Deterministic, so screenshots compare between runs. */
const seeded = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const QUIET = [
  ["info", "http", "request completed"],
  ["info", "http", "request completed"],
  ["debug", "db", "acquired connection from pool"],
  ["info", "payments", "charge authorized"],
  ["info", "cache", "cache hit ratio recalculated"],
] as const;

const INCIDENT = [
  ["error", "payments", "upstream timeout talking to stripe"],
  ["warn", "payments", "retrying idempotent request"],
  ["error", "http", "request failed: 504 gateway timeout"],
  ["warn", "db", "slow query: 2.4s"],
  ["info", "http", "request completed"],
] as const;

const SLOT_MS = 5_000;
const SPAN_MS = 15 * 60_000;

/**
 * Raw `<timestamp> <json>` lines of one pod for the last 15 minutes (the
 * caller adds the pod prefix and the timestamp format of the stream).
 */
export function volumeLogLines(podIndex: number, now: number): { ms: number; text: string }[] {
  const random = seeded(7 + podIndex * 31);
  const lines: { ms: number; text: string }[] = [];
  for (let start = now - SPAN_MS; start < now; start += SLOT_MS) {
    const minutesAgo = (now - start) / 60_000;
    const incident = minutesAgo > 4 && minutesAgo < 6.5;
    const wave = 1.6 + Math.sin(minutesAgo / 2.2) * 0.9;
    const count = Math.round((incident ? 9 + random() * 6 : wave + random() * 1.5) * (1 + podIndex * 0.15));
    for (let i = 0; i < count; i++) {
      const pool = incident && random() < 0.75 ? INCIDENT : QUIET;
      const [level, logger, msg] = pool[Math.floor(random() * pool.length)];
      const ms = Math.round(start + random() * SLOT_MS);
      const entry = { level, ts: new Date(ms).toISOString(), logger, msg, trace_id: Math.floor(random() * 1e12).toString(16) };
      lines.push({ ms, text: `${new Date(ms).toISOString()} ${JSON.stringify(entry)}` });
    }
  }
  return lines.sort((a, b) => a.ms - b.ms);
}

/* ------------------------------------------------------------ rollouts -- */

/* When a rollout started, by `context/namespace/plural/name`. */
const startedAt = new Map<string, number>();

/**
 * kubectl calls that start a rollout (`rollout restart|undo`, `scale`):
 * the workload's reads play it out from now on.
 */
export function noteRollout(args: string[], context: string) {
  const ref =
    args[0] === "rollout" && (args[1] === "restart" || args[1] === "undo")
      ? args[2]
      : args[0] === "scale"
        ? args.find((arg) => arg.includes("/") && !arg.startsWith("-"))
        : undefined;
  if (!ref) return;
  const namespaceAt = args.findIndex((arg) => arg === "--namespace" || arg.startsWith("--namespace="));
  const namespace =
    namespaceAt < 0 ? "" : args[namespaceAt].includes("=") ? args[namespaceAt].split("=")[1] : args[namespaceAt + 1];
  const [kind, name] = ref.split("/");
  startedAt.set(`${context}/${namespace}/${kind.toLowerCase()}s/${name}`, Date.now());
}

/*
 * Single workload reads (the rollout follower polls them). With
 * `?scenario=rollout`, a rollout started from the app plays out: one
 * replica moves to the new version every 1.5 s. `?scenario=rollout-stuck`
 * stops at one, then the controller gives up (ProgressDeadlineExceeded).
 */
export function createRolloutMocks(scenario: string) {
  registerKubeRoutes([
    {
      method: "GET",
      path: /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/(deployments|statefulsets|daemonsets)\/([^/]+)$/,
      handle: (request, match) => {
        const [, namespace, plural, name] = match.map((part) => decodeURIComponent(part ?? ""));
        const object = ((CLUSTERS[request.context] as any)?.[plural!] ?? []).find(
          (o: any) => o.metadata?.name === name && o.metadata?.namespace === namespace
        );
        if (!object) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        const started = startedAt.get(`${request.context}/${namespace}/${plural}/${name}`);
        if ((scenario !== "rollout" && scenario !== "rollout-stuck") || started === undefined) return object;

        const elapsed = Date.now() - started;
        const desired = object.spec?.replicas ?? 1;
        const generation = (object.metadata?.generation ?? 1) + 1;
        const stuck = scenario === "rollout-stuck";
        const updated = stuck ? 1 : Math.min(desired, Math.floor(elapsed / 1500));
        return {
          ...object,
          metadata: { ...object.metadata, generation },
          status: {
            ...object.status,
            observedGeneration: generation,
            replicas: desired + (updated < desired ? 1 : 0),
            updatedReplicas: updated,
            readyReplicas: desired,
            availableReplicas: desired,
            conditions:
              stuck && elapsed > 3000
                ? [
                    {
                      type: "Progressing",
                      status: "False",
                      reason: "ProgressDeadlineExceeded",
                      message: `ReplicaSet "${name}-6c9f7d8b5" has timed out progressing.`,
                    },
                  ]
                : object.status?.conditions,
          },
        };
      },
    },
  ]);

  // Desktop notifications: granted, and kept for inspection (no system UI here).
  const sent: { title: string; body?: string }[] = [];
  (window as any).__notifications = sent;
  (window as any).Notification = class {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title: string, options?: { body?: string }) {
      sent.push({ title, body: options?.body });
    }
  };
}
