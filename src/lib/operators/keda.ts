/*
 * KEDA: scaled objects / jobs in words (target, replica range, triggers like
 * "Prometheus: http_requests_total > 100", active / paused / fallback) and
 * the pause annotation. Pure, unit tested.
 */
import {
  conditionOf,
  humanize,
  isFalse,
  isTrue,
  listInWords,
  parseSimpleCron,
  type OperatorState,
} from "./format";

export const PAUSED_ANNOTATION = "autoscaling.keda.sh/paused";
export const PAUSED_REPLICAS_ANNOTATION = "autoscaling.keda.sh/paused-replicas";

/** Paused by annotation (or reported paused by KEDA). */
export function isPaused(object: any): boolean {
  const annotations = object?.metadata?.annotations ?? {};
  return (
    annotations[PAUSED_ANNOTATION] === "true" ||
    annotations[PAUSED_REPLICAS_ANNOTATION] !== undefined ||
    isTrue(conditionOf(object, "Paused"))
  );
}

/** Merge patch that pauses (or resumes) autoscaling. */
export const pausePatch = (paused: boolean) => ({
  metadata: {
    annotations: paused
      ? { [PAUSED_ANNOTATION]: "true" }
      : { [PAUSED_ANNOTATION]: null, [PAUSED_REPLICAS_ANNOTATION]: null },
  },
});

export function scaledObjectState(object: any): OperatorState {
  const ready = conditionOf(object, "Ready");
  const active = conditionOf(object, "Active");
  const fallback = conditionOf(object, "Fallback");
  if (isPaused(object)) {
    const replicas = object?.metadata?.annotations?.[PAUSED_REPLICAS_ANNOTATION];
    return {
      label: "Paused",
      tone: "info",
      message: replicas !== undefined ? `Held at ${replicas} replicas until resumed.` : "Replicas stay as they are until resumed.",
    };
  }
  if (isFalse(ready)) {
    return { label: "Not ready", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  if (isTrue(fallback)) {
    return {
      label: "Fallback",
      tone: "warning",
      reason: fallback!.reason,
      message: fallback!.message ?? "A trigger keeps failing: running on the fallback replica count.",
    };
  }
  if (isTrue(active)) return { label: "Active", tone: "success" };
  if (isFalse(active)) return { label: "Idle", tone: "muted", message: active!.message };
  return { label: "Pending", tone: "muted" };
}

/** "Deployment checkout-api" (kind defaults to Deployment). */
export function scaleTarget(object: any): { kind: string; name: string; apiVersion: string } | null {
  const ref = object?.spec?.scaleTargetRef;
  if (!ref?.name) return null;
  return { kind: ref.kind ?? "Deployment", name: ref.name, apiVersion: ref.apiVersion ?? "apps/v1" };
}

export interface ReplicaRange {
  min: number;
  max: number;
  idle?: number;
  /** "2–20". */
  text: string;
}

export function replicaRange(object: any): ReplicaRange {
  const spec = object?.spec ?? {};
  // KEDA's defaults; scaled jobs have no minimum replica count of their own.
  const min = Number(spec.minReplicaCount ?? 0);
  const max = Number(spec.maxReplicaCount ?? 100);
  const idle = spec.idleReplicaCount !== undefined ? Number(spec.idleReplicaCount) : undefined;
  return { min, max, idle, text: `${min}–${max}` };
}

/* PromQL words that are not metric names. */
const PROMQL_WORDS = new Set([
  "sum", "avg", "min", "max", "count", "rate", "irate", "increase", "by", "without",
  "on", "ignoring", "group_left", "group_right", "histogram_quantile", "topk", "bottomk",
  "abs", "ceil", "floor", "round", "clamp_min", "clamp_max", "delta", "deriv", "and", "or",
  "unless", "offset", "bool", "avg_over_time", "max_over_time", "min_over_time",
  "sum_over_time", "count_over_time", "quantile", "le", "vector", "scalar", "time",
]);

/** The first metric name in a PromQL query (`sum(rate(http_requests_total[2m]))`). */
export function promMetricName(query: string): string | undefined {
  const withoutLabels = query.replace(/\{[^}]*\}/g, "").replace(/\[[^\]]*\]/g, "");
  for (const match of withoutLabels.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    const word = match[0];
    const next = withoutLabels.slice((match.index ?? 0) + word.length).trimStart();
    if (!PROMQL_WORDS.has(word.toLowerCase()) && !next.startsWith("(")) return word;
  }
  return undefined;
}

const lastSegment = (value: string) => value.split(/[/:]/).filter(Boolean).pop() ?? value;

const messages = (count: unknown) => `${count} message${String(count) === "1" ? "" : "s"}`;

/* Words joined by spaces, empty parts left out. */
const words = (...parts: unknown[]) =>
  parts.filter((part) => part !== undefined && part !== null && part !== "").join(" ");

/**
 * One trigger in words: "Prometheus: http_requests_total > 100", "CPU at
 * 70%", "Kafka lag on orders > 50", "Schedule 08:00–18:00 → 10 replicas".
 */
export function triggerInWords(trigger: any): string {
  const type = String(trigger?.type ?? "");
  const m = trigger?.metadata ?? {};
  switch (type) {
    case "cpu":
    case "memory": {
      const name = type === "cpu" ? "CPU" : "Memory";
      const metricType = trigger.metricType ?? m.type ?? "Utilization";
      return metricType === "Utilization" ? `${name} at ${m.value}%` : `${name} at ${m.value}`;
    }
    case "prometheus": {
      const metric = m.metricName || (m.query ? promMetricName(String(m.query)) : undefined) || "query";
      return `Prometheus: ${metric} > ${m.threshold ?? "?"}`;
    }
    case "kafka":
      return `Kafka lag on ${m.topic ?? "topic"} > ${m.lagThreshold ?? 10}`;
    case "aws-sqs-queue":
      return `SQS ${m.queueURL ? lastSegment(String(m.queueURL)) : "queue"} > ${messages(m.queueLength ?? 5)}`;
    case "rabbitmq":
      return `RabbitMQ ${m.queueName ?? "queue"} > ${m.mode === "MessageRate" ? `${m.value} msg/s` : messages(m.value ?? m.queueLength ?? 20)}`;
    case "redis":
    case "redis-cluster":
      return words("Redis list", m.listName, ">", m.listLength ?? 5);
    case "redis-streams":
      return words("Redis stream", m.stream, "pending >", m.pendingEntriesCount ?? 5);
    case "cron": {
      const start = parseSimpleCron(m.start);
      const end = parseSimpleCron(m.end);
      const window =
        start && end && start.days === end.days
          ? `${start.days ?? "Daily"} ${start.time}–${end.time}`
          : `${m.start} to ${m.end}`;
      return `Schedule ${window} → ${m.desiredReplicas ?? "?"} replicas`;
    }
    case "azure-servicebus":
      return words("Service Bus", m.queueName ?? m.topicName, ">", messages(m.messageCount ?? 5));
    case "gcp-pubsub":
      return words("Pub/Sub", m.subscriptionName, ">", m.value ?? m.subscriptionSize ?? 5);
    case "nats-jetstream":
      return words("NATS", m.stream, "lag >", m.lagThreshold ?? 10);
    case "postgresql":
    case "mysql":
      return `${type === "mysql" ? "MySQL" : "PostgreSQL"} query > ${m.targetQueryValue ?? m.queryValue ?? "?"}`;
    case "metrics-api":
      return words("Metrics API", m.valueLocation, ">", m.targetValue ?? "?");
    case "external":
    case "external-push":
      return `External scaler${m.scalerAddress ? ` ${m.scalerAddress}` : ""}`;
    default: {
      const threshold = m.threshold ?? m.targetValue ?? m.value;
      return `${humanize(type)}${threshold !== undefined ? ` > ${threshold}` : ""}`;
    }
  }
}

export interface TriggerDetails {
  /** A query worth reading in full (Prometheus, SQL). */
  query?: string;
  fields: { label: string; value: string }[];
  auth?: { kind: string; name: string };
}

const DETAIL_FIELDS: Record<string, [string, string][]> = {
  prometheus: [["serverAddress", "Server"]],
  kafka: [["bootstrapServers", "Brokers"], ["consumerGroup", "Consumer group"]],
  "aws-sqs-queue": [["queueURL", "Queue"], ["awsRegion", "Region"]],
  rabbitmq: [["queueName", "Queue"], ["vhostName", "Virtual host"]],
  cron: [["timezone", "Time zone"]],
  redis: [["address", "Address"], ["listName", "List"]],
};

/** The parts of a trigger worth a second line in the side panel. */
export function triggerDetails(trigger: any): TriggerDetails {
  const metadata = trigger?.metadata ?? {};
  const fields = (DETAIL_FIELDS[trigger?.type] ?? [])
    .filter(([key]) => metadata[key])
    .map(([key, label]) => ({ label, value: String(metadata[key]) }));
  const auth = trigger?.authenticationRef?.name
    ? { kind: trigger.authenticationRef.kind ?? "TriggerAuthentication", name: trigger.authenticationRef.name }
    : undefined;
  return { query: metadata.query, fields, auth };
}

export const triggers = (object: any): any[] => object?.spec?.triggers ?? [];

/** All triggers in one line: "Prometheus: http_requests_total > 100, CPU at 70%". */
export const triggersInWords = (object: any, max = 2) =>
  listInWords(triggers(object).map(triggerInWords), max);

/** What a (Cluster)TriggerAuthentication reads secrets from, in words. */
export function authSourcesInWords(auth: any): string[] {
  const spec = auth?.spec ?? {};
  const sources: string[] = [];
  const secrets = [...new Set((spec.secretTargetRef ?? []).map((ref: any) => ref?.name).filter(Boolean))];
  if (secrets.length) sources.push(`Secret ${secrets.join(", ")}`);
  if ((spec.env ?? []).length) sources.push("Environment");
  if (spec.hashiCorpVault) sources.push("HashiCorp Vault");
  if (spec.awsSecretManager) sources.push("AWS Secrets Manager");
  if (spec.azureKeyVault) sources.push("Azure Key Vault");
  if (spec.gcpSecretManager) sources.push("Google Secret Manager");
  if (spec.configMapTargetRef?.length) sources.push("ConfigMap");
  if (spec.podIdentity?.provider && spec.podIdentity.provider !== "none") {
    const providers: Record<string, string> = {
      aws: "AWS pod identity",
      "aws-eks": "AWS IRSA",
      "azure-workload": "Azure workload identity",
      gcp: "GCP workload identity",
    };
    sources.push(providers[spec.podIdentity.provider] ?? humanize(spec.podIdentity.provider));
  }
  return sources;
}
