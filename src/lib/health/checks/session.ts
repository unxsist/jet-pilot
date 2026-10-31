/*
 * Results of the on-demand checks (Risks, Upgrades), kept for the session:
 * a tab checks a cluster the first time it's opened and shows that result
 * afterwards ("Checked 2 min ago · Check again"). Nothing polls. The
 * Clusters hub reads the same results, so it imports types only from the
 * checkers.
 */
import { reactive } from "vue";
import { errorText } from "@/lib/auth/classify";
import type { RiskReport } from "./collect";
import type { UpgradeReport } from "@/lib/upgrades/check";

export interface CheckState<T> {
  running: boolean;
  /** When it last finished (epoch ms). */
  at: number | null;
  result: T | null;
  error: string | null;
}

export function createSessionChecks<T>() {
  const states = reactive(new Map<string, CheckState<T>>()) as Map<string, CheckState<T>>;
  const inflight = new Map<string, Promise<void>>();

  /** Runs `task` for `key` unless it's running already; keeps the last result while it runs. */
  function run(key: string, task: () => Promise<T>): Promise<void> {
    const running = inflight.get(key);
    if (running) return running;
    const previous = states.get(key);
    states.set(key, { running: true, at: previous?.at ?? null, result: previous?.result ?? null, error: null });
    const promise = task()
      .then(
        (result) => void states.set(key, { running: false, at: Date.now(), result, error: null }),
        (error) =>
          void states.set(key, { running: false, at: Date.now(), result: previous?.result ?? null, error: errorText(error) })
      )
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return { get: (key: string) => states.get(key), run };
}

export const riskChecks = createSessionChecks<RiskReport>();
export const upgradeChecks = createSessionChecks<UpgradeReport>();
