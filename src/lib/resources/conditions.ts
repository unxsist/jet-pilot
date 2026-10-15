/*
 * Whether a status condition is good news (pure): "True" is healthy for
 * most types (Ready, Available), unhealthy for problem types (node
 * pressure, Failed, Degraded).
 */
import type { StatusTone } from "@/components/ui/status/tones";

export interface ConditionLike {
  type: string;
  status: string;
}

/* Conditions where "True" is bad news. */
const INVERTED = /(Pressure|Unavailable|Failed|Failure|Degraded|Stalled|Deadlock|Problem|Corrupt)$/;

/* Operator conditions that are normally False (KEDA, Karpenter, cert-manager). */
const NORMALLY_FALSE = /^(Fallback|Paused|Drifted|Denied|InvalidRequest|Issuing)$/;

/** Healthy, or unknown (neither True nor False): not worth a warning. */
export function conditionHealthy(condition: ConditionLike): boolean {
  if (condition.status !== "True" && condition.status !== "False") return true;
  return INVERTED.test(condition.type) || NORMALLY_FALSE.test(condition.type)
    ? condition.status === "False"
    : condition.status === "True";
}

export function conditionTone(condition: ConditionLike): StatusTone {
  if (condition.status !== "True" && condition.status !== "False") return "muted";
  return conditionHealthy(condition) ? "success" : "warning";
}
