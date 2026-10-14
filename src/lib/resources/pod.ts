/*
 * A pod in words (pure, unit tested): its state with the reason, what it
 * uses (config, secrets, claims), where it may run, its probes and the
 * chain of owners above it.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import { ago, between, durationWords, listWords, plural, sentence, toMs } from "./format";
import type { ObjectRef } from "./kinds";

/** An object's state for the top of its panel and its describe. */
export interface ObjectState {
  label: string;
  tone: StatusTone;
  /** One or two plain sentences: what is going on, and why. */
  detail?: string;
  /** Since when it is in this state (ISO time). */
  since?: string;
}

/* Just enough of a pod for these helpers (V1Pod fits). */
export interface PodLike {
  metadata?: {
    name?: string;
    namespace?: string;
    deletionTimestamp?: unknown;
    deletionGracePeriodSeconds?: number;
    ownerReferences?: { kind: string; name: string; apiVersion?: string; controller?: boolean }[];
  };
  spec?: any;
  status?: any;
}

/* --------------------------------------------------------- state -- */

const EXIT_CODES: Record<number, string> = {
  126: "the command can't run",
  127: "command not found",
  137: "killed",
  139: "segmentation fault",
  143: "stopped",
};

const exitWords = (code: number | undefined) => {
  if (code === undefined) return "it stops";
  const meaning = EXIT_CODES[code];
  return `it exits with code ${code}${meaning ? ` (${meaning})` : ""}`;
};

const toDate = (value: unknown) => {
  const ms = toMs(value);
  return ms === null ? undefined : new Date(ms).toISOString();
};

/**
 * What the pod is doing, in words: "Running", "Restarting" with the exit
 * code and when it last crashed, "Out of memory" with the limit, "Can't be
 * scheduled" with the scheduler's reason, and so on.
 */
export function podState(pod: PodLike, now = Date.now()): ObjectState {
  const status = pod.status ?? {};
  const spec = pod.spec ?? {};
  const containers: any[] = spec.containers ?? [];
  const single = containers.length + (spec.initContainers?.length ?? 0) <= 1;
  const who = (name: string) => (single ? "The container" : name);

  const deletion = toMs(pod.metadata?.deletionTimestamp);
  if (deletion !== null) {
    // deletionTimestamp is when the grace period ends.
    if (now - deletion > 60_000) {
      return {
        label: "Stuck terminating",
        tone: "destructive",
        detail: `Its grace period ended ${ago(deletion, now)}. A finalizer or an unreachable node can keep a pod around.`,
        since: toDate(deletion),
      };
    }
    return {
      label: "Terminating",
      tone: "warning",
      detail: `Shutting down; it has until ${new Date(deletion).toLocaleTimeString()} to stop.`,
      since: toDate(deletion),
    };
  }

  if (status.reason === "Evicted") {
    return { label: "Evicted", tone: "destructive", detail: sentence(status.message ?? "The node ran out of resources.") };
  }

  const scheduled = (status.conditions ?? []).find((c: any) => c.type === "PodScheduled");
  if (status.phase === "Pending" && scheduled?.status === "False") {
    return {
      label: "Can't be scheduled",
      tone: "warning",
      detail: sentence(scheduled.message ?? "No node can run it yet."),
      since: toDate(scheduled.lastTransitionTime),
    };
  }

  // Init containers run first, one at a time.
  const initStatuses: any[] = status.initContainerStatuses ?? [];
  for (const [index, init] of initStatuses.entries()) {
    if (init.state?.terminated?.exitCode === 0) continue;
    const initSpec = spec.initContainers?.find((c: any) => c.name === init.name);
    // Sidecars (restartPolicy Always) keep running next to the app.
    if (initSpec?.restartPolicy === "Always" && init.state?.running) continue;
    const problem = containerProblem(init, initSpec, who(init.name), now);
    if (problem) return { ...problem, label: problem.label === "Restarting" ? "Init container failing" : problem.label };
    if (init.state?.running || init.state?.waiting) {
      return {
        label: "Initializing",
        tone: "warning",
        detail: `Running init container ${init.name} (${index + 1} of ${initStatuses.length}).`,
        since: toDate(init.state?.running?.startedAt ?? status.startTime),
      };
    }
  }

  const statuses: any[] = status.containerStatuses ?? [];
  for (const container of statuses) {
    const problem = containerProblem(
      container,
      containers.find((c: any) => c.name === container.name),
      who(container.name),
      now,
      spec.restartPolicy
    );
    if (problem) return problem;
  }

  if (status.phase === "Succeeded") {
    const finished = latest(statuses.map((c) => c.state?.terminated?.finishedAt));
    const took = between(status.startTime, finished);
    return {
      label: "Completed",
      tone: "muted",
      detail: finished ? `Finished ${ago(finished, now)}${took ? `, after ${took}` : ""}.` : undefined,
      since: toDate(finished),
    };
  }
  if (status.phase === "Failed") {
    const failed = statuses.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0);
    return {
      label: "Failed",
      tone: "destructive",
      detail: sentence(
        status.message ??
          (failed ? `${who(failed.name)} exited with code ${failed.state.terminated.exitCode}.` : "It stopped with an error.")
      ),
      since: toDate(failed?.state?.terminated?.finishedAt),
    };
  }

  const waiting = statuses.find((c) => c.state?.waiting);
  if (waiting) {
    const reason = waiting.state.waiting.reason;
    return {
      label: reason === "PodInitializing" ? "Initializing" : "Starting",
      tone: "warning",
      detail: reason === "ContainerCreating" ? "Pulling images and creating the containers." : undefined,
      since: toDate(status.startTime),
    };
  }

  if (status.phase === "Running") {
    const notReady = statuses.filter((c) => !c.ready);
    const readyCondition = (status.conditions ?? []).find((c: any) => c.type === "Ready");
    if (notReady.length > 0) {
      const names = notReady.map((c) => c.name);
      const probe = notReady.some((c) => containers.find((s: any) => s.name === c.name)?.readinessProbe);
      return {
        label: "Not ready",
        tone: "warning",
        detail: single
          ? `The container runs but isn't ready${probe ? ": its readiness probe doesn't pass" : ""}. Services don't send it traffic.`
          : `${listWords(names)} ${names.length === 1 ? "isn't" : "aren't"} ready yet (${statuses.length - notReady.length} of ${statuses.length} ready). Services don't send it traffic.`,
        since: toDate(readyCondition?.lastTransitionTime),
      };
    }
    return { label: "Running", tone: "success", since: toDate(readyCondition?.lastTransitionTime ?? status.startTime) };
  }

  return { label: status.phase ?? "Unknown", tone: status.phase ? "warning" : "muted", since: toDate(status.startTime) };
}

const latest = (values: unknown[]) => {
  const times = values.map(toMs).filter((t): t is number => t !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
};

/* A failing container (crashing, out of memory, can't pull, ...), or null. */
function containerProblem(
  status: any,
  spec: any,
  who: string,
  now: number,
  restartPolicy?: string
): ObjectState | null {
  const waiting = status.state?.waiting;
  const terminated = status.state?.terminated;
  const last = status.lastState?.terminated;
  const restarts = status.restartCount ?? 0;
  const restartText = restarts > 0 ? ` ${sentence(plural(restarts, "restart"))} so far.` : "";
  const memoryLimit = spec?.resources?.limits?.memory;

  const oom = (at: unknown) => ({
    label: "Out of memory",
    tone: "destructive" as const,
    detail: `${who} was killed for using more memory than ${memoryLimit ? `its ${memoryLimit} limit` : "the node had"}, ${ago(at, now)}.${restartText}`,
  });

  switch (waiting?.reason) {
    case "CrashLoopBackOff": {
      if (last?.reason === "OOMKilled") return oom(last.finishedAt);
      return {
        label: "Restarting",
        tone: "destructive",
        detail: `${who} keeps crashing: ${exitWords(last?.exitCode)}${last?.finishedAt ? `, last ${ago(last.finishedAt, now)}` : ""}.${restartText}`,
      };
    }
    case "ImagePullBackOff":
    case "ErrImagePull":
    case "ErrImageNeverPull":
      return {
        label: "Can't pull the image",
        tone: "destructive",
        detail: `${status.image ?? spec?.image ?? "The image"} can't be pulled. Check the name and tag, and the registry credentials.`,
      };
    case "InvalidImageName":
      return { label: "Invalid image name", tone: "destructive", detail: sentence(waiting.message ?? "") || undefined };
    case "CreateContainerConfigError":
      return {
        label: "Configuration error",
        tone: "destructive",
        detail: sentence(`${waiting.message ?? "A ConfigMap or Secret it needs is missing"}.`.replace(/\.\.$/, ".")),
      };
    case "CreateContainerError":
    case "RunContainerError":
      return { label: "Can't start", tone: "destructive", detail: sentence(waiting.message ?? "") || undefined };
  }

  if (terminated && terminated.exitCode !== 0) {
    if (terminated.reason === "OOMKilled") return oom(terminated.finishedAt);
    if (restartPolicy !== "Never") {
      return {
        label: "Restarting",
        tone: "destructive",
        detail: `${who} crashed: ${exitWords(terminated.exitCode)}, ${ago(terminated.finishedAt, now)}.${restartText}`,
      };
    }
  }
  return null;
}

/* ---------------------------------------------------------- QoS -- */

export const QOS_WORDS: Record<string, string> = {
  Guaranteed: "Requests equal limits: evicted last when the node runs short",
  Burstable: "Can use more than it requests: evicted after best-effort pods",
  BestEffort: "No requests or limits: evicted first when the node runs short",
};

/* ------------------------------------------------- config & storage -- */

export interface PodUse {
  /** ConfigMap, Secret, PersistentVolumeClaim or a volume type in words. */
  kind: string;
  /** The object it refers to, if any. */
  ref?: ObjectRef;
  /** "Scratch space", "Host path /var/log", or the object's name. */
  title: string;
  /** How: "Mounted at /etc/config", "As environment variables". */
  how: string[];
  optional?: boolean;
}

const VOLUME_WORDS: Record<string, string> = {
  emptyDir: "Scratch space",
  hostPath: "Host path",
  nfs: "NFS share",
  csi: "CSI volume",
  ephemeral: "Ephemeral volume",
  downwardAPI: "Pod information",
  image: "Image volume",
};

/* The token, CA and namespace every pod gets: not worth a line. */
const isDefaultToken = (volume: any) =>
  volume.projected && /^kube-api-access-?/.test(volume.name ?? "");

/**
 * What a pod uses: ConfigMaps and Secrets (as volumes, environment or pull
 * secrets), claims and other volumes, each with where it ends up.
 */
export function podUses(pod: PodLike): PodUse[] {
  const spec = pod.spec ?? {};
  const namespace = pod.metadata?.namespace;
  const uses = new Map<string, PodUse>();
  const use = (kind: string, name: string, how: string, optional?: boolean) => {
    const key = `${kind}/${name}`;
    const existing = uses.get(key);
    if (existing) {
      if (!existing.how.includes(how)) existing.how.push(how);
      return;
    }
    uses.set(key, { kind, ref: { kind, name, namespace }, title: name, how: [how], optional });
  };

  const containers: any[] = [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
  const mounts = (volume: string) =>
    containers.flatMap((c) =>
      (c.volumeMounts ?? [])
        .filter((m: any) => m.name === volume)
        .map((m: any) => `${m.mountPath}${m.readOnly ? " (read-only)" : ""}${containers.length > 1 ? ` in ${c.name}` : ""}`)
    );
  const mounted = (volume: string) => {
    const paths = mounts(volume);
    return paths.length ? `Mounted at ${listWords(paths)}` : "A volume, not mounted";
  };

  for (const volume of spec.volumes ?? []) {
    if (isDefaultToken(volume)) continue;
    const how = mounted(volume.name);
    if (volume.configMap) use("ConfigMap", volume.configMap.name, how, volume.configMap.optional);
    else if (volume.secret) use("Secret", volume.secret.secretName, how, volume.secret.optional);
    else if (volume.persistentVolumeClaim) use("PersistentVolumeClaim", volume.persistentVolumeClaim.claimName, how);
    else if (volume.projected) {
      for (const source of volume.projected.sources ?? []) {
        if (source.configMap) use("ConfigMap", source.configMap.name, how, source.configMap.optional);
        if (source.secret) use("Secret", source.secret.name, how, source.secret.optional);
      }
    } else {
      const type = Object.keys(volume).find((key) => key !== "name") ?? "volume";
      const title =
        type === "hostPath"
          ? `Host path ${volume.hostPath.path}`
          : type === "emptyDir" && volume.emptyDir?.medium === "Memory"
            ? "Scratch space in memory"
            : (VOLUME_WORDS[type] ?? type);
      uses.set(`volume/${volume.name}`, { kind: type, title, how: [how] });
    }
  }

  for (const container of containers) {
    for (const source of container.envFrom ?? []) {
      if (source.configMapRef) use("ConfigMap", source.configMapRef.name, "As environment variables", source.configMapRef.optional);
      if (source.secretRef) use("Secret", source.secretRef.name, "As environment variables", source.secretRef.optional);
    }
    for (const variable of container.env ?? []) {
      const from = variable.valueFrom;
      if (from?.configMapKeyRef) use("ConfigMap", from.configMapKeyRef.name, `Key ${from.configMapKeyRef.key} as ${variable.name}`, from.configMapKeyRef.optional);
      if (from?.secretKeyRef) use("Secret", from.secretKeyRef.name, `Key ${from.secretKeyRef.key} as ${variable.name}`, from.secretKeyRef.optional);
    }
  }
  for (const secret of spec.imagePullSecrets ?? []) {
    if (secret.name) use("Secret", secret.name, "To pull images");
  }

  // Claims first, then config, then the rest.
  const order = (kind: string) => (kind === "PersistentVolumeClaim" ? 0 : kind === "ConfigMap" ? 1 : kind === "Secret" ? 2 : 3);
  return [...uses.values()].sort((a, b) => order(a.kind) - order(b.kind));
}

/* ------------------------------------------------------- scheduling -- */

/* Well-known node and topology labels, in words. */
const LABEL_WORDS: Record<string, string> = {
  "topology.kubernetes.io/zone": "zone",
  "failure-domain.beta.kubernetes.io/zone": "zone",
  "topology.kubernetes.io/region": "region",
  "kubernetes.io/hostname": "node",
  "kubernetes.io/arch": "architecture",
  "kubernetes.io/os": "OS",
  "node.kubernetes.io/instance-type": "instance type",
  "karpenter.sh/capacity-type": "capacity type",
  "eks.amazonaws.com/capacityType": "capacity type",
  "karpenter.sh/nodepool": "node pool",
  "eks.amazonaws.com/nodegroup": "node group",
  "cloud.google.com/gke-nodepool": "node pool",
  "kubernetes.azure.com/agentpool": "agent pool",
};

const labelWord = (key: string) => LABEL_WORDS[key] ?? key;
const or = (values: string[] = []) => (values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`);

function expressionWords(e: { key: string; operator: string; values?: string[] }): string {
  const key = labelWord(e.key);
  switch (e.operator) {
    case "In":
      return `${key} is ${or(e.values)}`;
    case "NotIn":
      return `${key} isn't ${or(e.values)}`;
    case "Exists":
      return `${key === e.key ? `the label ${key}` : `a ${key}`} is set`;
    case "DoesNotExist":
      return `${key === e.key ? `the label ${key}` : `a ${key}`} isn't set`;
    case "Gt":
      return `${key} is above ${e.values?.[0]}`;
    case "Lt":
      return `${key} is below ${e.values?.[0]}`;
    default:
      return `${e.key} ${e.operator} ${(e.values ?? []).join(",")}`;
  }
}

const termWords = (term: any) =>
  [...(term.matchExpressions ?? []), ...(term.matchFields ?? [])].map(expressionWords).join(" and ");

const selectorWords = (selector: any): string => {
  const parts = [
    ...Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(selector?.matchExpressions ?? []).map(expressionWords),
  ];
  return parts.length ? parts.join(", ") : "any labels";
};

const topologyWords = (key: string) =>
  key === "kubernetes.io/hostname" ? "node" : LABEL_WORDS[key] ?? `${key} value`;

/* Added to every pod by the DefaultTolerationSeconds admission plugin. */
const isDefaultToleration = (t: any) =>
  (t.key === "node.kubernetes.io/not-ready" || t.key === "node.kubernetes.io/unreachable") &&
  t.operator === "Exists" &&
  t.effect === "NoExecute" &&
  t.tolerationSeconds === 300;

export function tolerationWords(t: any): string {
  const seconds = t.tolerationSeconds !== undefined ? ` for ${durationWords(t.tolerationSeconds * 1000)}` : "";
  if (!t.key && t.operator === "Exists") return `Tolerates every taint${t.effect ? ` with effect ${t.effect}` : ""}${seconds}`;
  const what = t.operator === "Exists" || !t.value ? t.key : `${t.key}=${t.value}`;
  return `Tolerates ${what}${t.effect ? `:${t.effect}` : ""}${seconds}`;
}

/**
 * Where a pod may run, one sentence per rule: node selector, node and pod
 * (anti-)affinity, topology spread and tolerations (without the two every
 * pod gets).
 */
export function schedulingWords(spec: any): { rules: string[]; tolerations: string[] } {
  const rules: string[] = [];
  const nodeSelector = Object.entries(spec?.nodeSelector ?? {});
  if (nodeSelector.length) {
    rules.push(`Only on nodes where ${nodeSelector.map(([k, v]) => `${labelWord(k)} is ${v}`).join(" and ")}`);
  }
  const node = spec?.affinity?.nodeAffinity;
  const required = node?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  if (required.length) rules.push(`Only on nodes where ${required.map(termWords).filter(Boolean).join(", or ")}`);
  for (const preferred of node?.preferredDuringSchedulingIgnoredDuringExecution ?? []) {
    const words = termWords(preferred.preference ?? {});
    if (words) rules.push(`Prefers nodes where ${words}`);
  }

  const podRules = (affinity: any, anti: boolean) => {
    for (const term of affinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
      const where = topologyWords(term.topologyKey);
      rules.push(
        anti
          ? `Never on the same ${where} as pods with ${selectorWords(term.labelSelector)}`
          : `Only on a ${where} that runs pods with ${selectorWords(term.labelSelector)}`
      );
    }
    for (const weighted of affinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []) {
      const term = weighted.podAffinityTerm ?? {};
      const where = topologyWords(term.topologyKey);
      rules.push(
        anti
          ? `Avoids sharing a ${where} with pods with ${selectorWords(term.labelSelector)}`
          : `Prefers a ${where} that runs pods with ${selectorWords(term.labelSelector)}`
      );
    }
  };
  podRules(spec?.affinity?.podAffinity, false);
  podRules(spec?.affinity?.podAntiAffinity, true);

  for (const constraint of spec?.topologySpreadConstraints ?? []) {
    const where = topologyWords(constraint.topologyKey);
    const strict = constraint.whenUnsatisfiable !== "ScheduleAnyway";
    rules.push(
      `Spread across ${where === "node" ? "nodes" : `${where}s`}, at most ${constraint.maxSkew} apart${strict ? "" : " when possible"}`
    );
  }
  if (spec?.priorityClassName) rules.push(`Priority class ${spec.priorityClassName}`);

  const tolerations = (spec?.tolerations ?? []).filter((t: any) => !isDefaultToleration(t)).map(tolerationWords);
  return { rules, tolerations };
}

/* ----------------------------------------------------------- probes -- */

export interface ProbeWords {
  type: "Startup" | "Liveness" | "Readiness";
  check: string;
  timing: string;
}

const portWords = (port: unknown) => (typeof port === "number" ? `port ${port}` : `port ${String(port)}`);

/** A probe in words: what it checks, how often, and what failing does. */
export function probeWords(probe: any, type: ProbeWords["type"]): ProbeWords {
  let check = "A check";
  if (probe.httpGet) {
    const scheme = probe.httpGet.scheme === "HTTPS" ? "HTTPS" : "HTTP";
    check = `${scheme} GET ${probe.httpGet.path ?? "/"} on ${portWords(probe.httpGet.port)}`;
  } else if (probe.tcpSocket) {
    check = `TCP connection to ${portWords(probe.tcpSocket.port)}`;
  } else if (probe.grpc) {
    check = `gRPC health check on ${portWords(probe.grpc.port)}`;
  } else if (probe.exec) {
    const command = (probe.exec.command ?? []).join(" ");
    check = `Runs ${command.length > 60 ? `${command.slice(0, 57)}…` : command}`;
  }
  const period = probe.periodSeconds ?? 10;
  const failures = probe.failureThreshold ?? 3;
  const delay = probe.initialDelaySeconds ? `, from ${durationWords(probe.initialDelaySeconds * 1000)} after start` : "";
  const outcome =
    type === "Liveness"
      ? `${plural(failures, "failure")} in a row restart it`
      : type === "Readiness"
        ? `${plural(failures, "failure")} in a row take it out of its Services`
        : `it has ${durationWords(failures * period * 1000)} to start`;
  return { type, check, timing: `Every ${durationWords(period * 1000)}${delay}; ${outcome}` };
}

/** Probes of a container, startup first. */
export function containerProbes(container: any): ProbeWords[] {
  return [
    container.startupProbe && probeWords(container.startupProbe, "Startup"),
    container.livenessProbe && probeWords(container.livenessProbe, "Liveness"),
    container.readinessProbe && probeWords(container.readinessProbe, "Readiness"),
  ].filter(Boolean) as ProbeWords[];
}

/* ----------------------------------------------------------- owners -- */

/** The controlling owner reference (or the first one). */
export function ownerOf(object: PodLike): ObjectRef | null {
  const refs = object.metadata?.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref ? { kind: ref.kind, name: ref.name, apiVersion: ref.apiVersion, namespace: object.metadata?.namespace } : null;
}

/**
 * The owners above an object, nearest first (Pod → ReplicaSet →
 * Deployment): each level is fetched to read its own owner. Stops at an
 * object without owner, one that can't be fetched, or after `depth` levels.
 */
export async function resolveOwners(
  object: PodLike,
  fetchOwner: (ref: ObjectRef) => Promise<PodLike | null>,
  depth = 4
): Promise<ObjectRef[]> {
  const chain: ObjectRef[] = [];
  let current: PodLike | null = object;
  while (current && chain.length < depth) {
    const owner = ownerOf(current);
    if (!owner || chain.some((r) => r.kind === owner.kind && r.name === owner.name)) break;
    chain.push(owner);
    current = await fetchOwner(owner).catch(() => null);
  }
  return chain;
}
