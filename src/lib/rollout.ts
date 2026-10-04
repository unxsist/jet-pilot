/*
 * Rollout history of Deployments (ReplicaSets) and StatefulSets / DaemonSets
 * (ControllerRevisions), plus rollout progress. Pure functions, unit tested.
 */

export type RolloutKind = "Deployment" | "StatefulSet" | "DaemonSet";

export const ROLLOUT_KINDS: RolloutKind[] = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
];

export const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";
export const CHANGE_CAUSE_ANNOTATION = "kubernetes.io/change-cause";

interface Meta {
  name?: string;
  uid?: string;
  generation?: number;
  creationTimestamp?: string | Date;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  ownerReferences?: { uid?: string; controller?: boolean }[];
}

interface Container {
  name?: string;
  image?: string;
}

export interface PodTemplate {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: { containers?: Container[]; initContainers?: Container[] } & Record<string, unknown>;
}

export interface Workload {
  kind?: string;
  metadata?: Meta;
  spec?: {
    replicas?: number;
    paused?: boolean;
    template?: PodTemplate;
    updateStrategy?: { type?: string };
    strategy?: { type?: string };
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    unavailableReplicas?: number;
    currentRevision?: string;
    updateRevision?: string;
    // DaemonSet
    desiredNumberScheduled?: number;
    updatedNumberScheduled?: number;
    numberReady?: number;
    numberAvailable?: number;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  };
}

export interface Revision {
  revision: number;
  /* ReplicaSet / ControllerRevision name */
  name: string;
  created: Date | null;
  changeCause: string;
  images: string[];
  template: PodTemplate;
  current: boolean;
  /* ReplicaSets only: replicas still running this revision */
  replicas?: number;
  readyReplicas?: number;
}

const ownedBy = (meta: Meta | undefined, uid: string | undefined) =>
  !!uid && (meta?.ownerReferences ?? []).some((ref) => ref.uid === uid);

const toDate = (value: string | Date | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const templateImages = (template: PodTemplate | undefined): string[] =>
  [...(template?.spec?.initContainers ?? []), ...(template?.spec?.containers ?? [])]
    .map((c) => c.image)
    .filter((image): image is string => !!image);

/* The controller adds these to every revision; they only add diff noise. */
const stripTemplateNoise = (template: PodTemplate | undefined): PodTemplate => {
  const copy: PodTemplate = JSON.parse(JSON.stringify(template ?? {}));
  if (copy.metadata?.labels) {
    delete copy.metadata.labels["pod-template-hash"];
    delete copy.metadata.labels["controller-revision-hash"];
    if (Object.keys(copy.metadata.labels).length === 0) delete copy.metadata.labels;
  }
  if (copy.metadata && Object.keys(copy.metadata).length === 0) delete copy.metadata;
  return copy;
};

const byRevisionDesc = (a: Revision, b: Revision) => b.revision - a.revision;

/** Revisions of a Deployment from its ReplicaSets (newest first). */
export function deploymentRevisions(
  deployment: Workload,
  replicaSets: (Workload & { spec?: { template?: PodTemplate } })[]
): Revision[] {
  const uid = deployment.metadata?.uid;
  const current = Number(deployment.metadata?.annotations?.[REVISION_ANNOTATION]);

  return replicaSets
    .filter((rs) => ownedBy(rs.metadata, uid))
    .map((rs) => {
      const revision = Number(rs.metadata?.annotations?.[REVISION_ANNOTATION]);
      return {
        revision,
        name: rs.metadata?.name ?? "",
        created: toDate(rs.metadata?.creationTimestamp),
        changeCause: rs.metadata?.annotations?.[CHANGE_CAUSE_ANNOTATION] ?? "",
        images: templateImages(rs.spec?.template),
        template: stripTemplateNoise(rs.spec?.template),
        current: revision === current,
        replicas: rs.status?.replicas ?? 0,
        readyReplicas: rs.status?.readyReplicas ?? 0,
      };
    })
    .filter((r) => Number.isFinite(r.revision) && r.revision > 0)
    .sort(byRevisionDesc);
}

export interface ControllerRevision {
  metadata?: Meta;
  revision?: number | string;
  data?: { spec?: { template?: PodTemplate } };
}

/**
 * Revisions of a StatefulSet / DaemonSet from its ControllerRevisions
 * (newest first). The current one is the StatefulSet's updateRevision, or
 * the highest revision for DaemonSets.
 */
export function controllerRevisions(
  workload: Workload,
  revisions: ControllerRevision[]
): Revision[] {
  const uid = workload.metadata?.uid;
  const owned = revisions.filter((r) => ownedBy(r.metadata, uid));
  const highest = Math.max(0, ...owned.map((r) => Number(r.revision) || 0));
  const updateRevision = workload.status?.updateRevision;

  return owned
    .map((r) => {
      const revision = Number(r.revision) || 0;
      const template = r.data?.spec?.template;
      return {
        revision,
        name: r.metadata?.name ?? "",
        created: toDate(r.metadata?.creationTimestamp),
        changeCause: r.metadata?.annotations?.[CHANGE_CAUSE_ANNOTATION] ?? "",
        images: templateImages(template),
        template: stripTemplateNoise(template),
        current: updateRevision
          ? r.metadata?.name === updateRevision
          : revision === highest,
      };
    })
    .filter((r) => r.revision > 0)
    .sort(byRevisionDesc);
}

/* ---------------------------------------------------------- progress -- */

export type RolloutPhase = "complete" | "progressing" | "paused" | "failed";

export interface RolloutProgress {
  phase: RolloutPhase;
  desired: number;
  updated: number;
  ready: number;
  available: number;
  /* 0..1, updated-and-available share of the desired replicas */
  ratio: number;
  message: string;
}

/**
 * Rollout progress of a workload from its status, following the checks of
 * `kubectl rollout status`.
 */
export function rolloutProgress(workload: Workload): RolloutProgress {
  const kind = workload.kind;
  const status = workload.status ?? {};
  const spec = workload.spec ?? {};

  let desired: number;
  let updated: number;
  let ready: number;
  let available: number;
  if (kind === "DaemonSet") {
    desired = status.desiredNumberScheduled ?? 0;
    updated = status.updatedNumberScheduled ?? 0;
    ready = status.numberReady ?? 0;
    available = status.numberAvailable ?? 0;
  } else {
    desired = spec.replicas ?? 1;
    updated = status.updatedReplicas ?? 0;
    ready = status.readyReplicas ?? 0;
    available = kind === "StatefulSet" ? ready : status.availableReplicas ?? 0;
  }
  const total = status.replicas ?? desired;
  const ratio = desired > 0 ? Math.min(1, Math.min(updated, available) / desired) : 1;
  const base = { desired, updated, ready, available, ratio };

  const progressing = status.conditions?.find((c) => c.type === "Progressing");
  if (progressing?.reason === "ProgressDeadlineExceeded") {
    return {
      ...base,
      phase: "failed",
      message: progressing.message || "Progress deadline exceeded",
    };
  }
  if (kind === "Deployment" && spec.paused) {
    return { ...base, phase: "paused", message: "Rollout is paused" };
  }

  const generation = workload.metadata?.generation;
  const observed =
    status.observedGeneration === undefined ||
    generation === undefined ||
    status.observedGeneration >= generation;
  if (!observed) {
    return { ...base, phase: "progressing", message: "Waiting for the controller to observe the update" };
  }

  if (kind === "StatefulSet" && spec.updateStrategy?.type === "OnDelete") {
    return { ...base, phase: "complete", message: "OnDelete strategy: pods update when deleted" };
  }

  if (updated < desired) {
    return {
      ...base,
      phase: "progressing",
      message: `${updated} of ${desired} updated replicas`,
    };
  }
  if (total > updated) {
    return {
      ...base,
      phase: "progressing",
      message: `${total - updated} old replicas pending termination`,
    };
  }
  if (available < updated) {
    return {
      ...base,
      phase: "progressing",
      message: `${available} of ${updated} updated replicas available`,
    };
  }
  if (
    kind === "StatefulSet" &&
    status.updateRevision &&
    status.currentRevision !== status.updateRevision
  ) {
    return { ...base, phase: "progressing", message: "Waiting for the update to finish" };
  }
  return { ...base, phase: "complete", message: "Rollout complete" };
}

/** argv (without `kubectl`) for `kubectl rollout <verb> kind/name`. */
export function rolloutArgs(
  verb: "undo" | "restart" | "pause" | "resume" | "status",
  kind: string,
  name: string,
  extra: string[] = []
): string[] {
  return ["rollout", verb, `${kind.toLowerCase()}/${name}`, ...extra];
}
