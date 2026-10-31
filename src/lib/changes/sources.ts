/*
 * Changes reconstructed from the cluster itself, and from the recorder's
 * records: each function turns one kind of evidence into timeline changes.
 * Pure: the objects come in, `Change`s go out (see ./model).
 *
 *   ReplicaSets         a Deployment's revisions, with the template diff
 *   ControllerRevisions a StatefulSet's or DaemonSet's revisions
 *   Helm history        chart and values per revision
 *   Argo CD / Flux      sync history, HelmRelease history, applied revisions
 *   managedFields       who wrote an object last, and what they own
 *   pods, nodes, events restarts, condition transitions, warnings, scaling
 */
import type { StatusTone } from "@/components/ui/status/tones";
import { REVISION_ANNOTATION } from "@/lib/rollout";
import { diffFields, sides, type FieldChange } from "./fields";
import { CHANGES_WINDOW_MS, MINUTE, type Change, type ChangeKind, type ChangeTarget } from "./model";
import {
  conditionWords,
  eventWords,
  fieldWords,
  helmWords,
  isRestart,
  keyWords,
  managedWords,
  ownedTopics,
  restartWords,
  shortRevision,
  type HelmRevisionLike,
  type Phrase,
} from "./words";

/** The time window changes must fall in (epoch ms). */
export interface Window {
  from: number;
  to: number;
}

export const lastDays = (now = Date.now(), span = CHANGES_WINDOW_MS): Window => ({ from: now - span, to: now + MINUTE });

const ms = (value: unknown) => (typeof value === "string" && value ? Date.parse(value) : NaN);
const inWindow = (at: unknown, window: Window) => {
  const t = ms(at);
  return Number.isFinite(t) && t >= window.from && t <= window.to;
};

const make = (
  target: ChangeTarget,
  fields: Omit<Change, "target" | "summary" | "sentence" | "recorded"> & { words: Phrase; recorded?: boolean }
): Change => {
  const { words, recorded = false, ...rest } = fields;
  return { ...rest, target, summary: words.text, sentence: words.sentence, recorded };
};

/* ------------------------------------------------------- templates -- */

/* Labels the controllers add to every revision: diff noise. */
const NOISE_LABELS = ["pod-template-hash", "controller-revision-hash"];

/** A pod template without controller noise or strategic-merge markers. */
export function cleanTemplate(template: unknown): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("$"))
        .map(([key, v]) => [key, strip(v)])
    );
  };
  const copy = strip(template ?? {}) as any;
  for (const label of NOISE_LABELS) delete copy?.metadata?.labels?.[label];
  if (copy?.metadata?.labels && !Object.keys(copy.metadata.labels).length) delete copy.metadata.labels;
  if (copy?.metadata && !Object.keys(copy.metadata).length) delete copy.metadata;
  return copy;
}

/* What a template diff did: a restart, or a template change. */
const templateKind = (fields: FieldChange[]): ChangeKind => (fields.length > 0 && fields.every(isRestart) ? "restart" : "template");

interface Revisioned {
  owner: { kind: string; name: string; uid: string };
  namespace: string;
  revision: number;
  created: string;
  template: Record<string, unknown>;
  /** Reused by a rollback: its creation isn't when it became current. */
  reused: boolean;
}

function revisionChanges(target: ChangeTarget, revisions: Revisioned[], window: Window): Change[] {
  const byOwner = new Map<string, Revisioned[]>();
  for (const r of revisions) byOwner.set(r.owner.uid, [...(byOwner.get(r.owner.uid) ?? []), r]);
  const out: Change[] = [];
  for (const list of byOwner.values()) {
    list.sort((a, b) => a.revision - b.revision);
    list.forEach((current, index) => {
      const previous = list[index - 1];
      if (!previous || current.reused || !inWindow(current.created, window)) return;
      const fields = diffFields(previous.template, current.template);
      if (!fields.length) return;
      out.push(
        make(target, {
          key: `revision:${current.owner.uid}:${current.revision}`,
          at: current.created,
          object: { kind: current.owner.kind, name: current.owner.name, namespace: current.namespace, uid: current.owner.uid },
          kind: templateKind(fields),
          words: fieldWords(fields),
          source: "revisions",
          diff: {
            before: previous.template,
            after: current.template,
            beforeLabel: `Revision ${previous.revision}`,
            afterLabel: `Revision ${current.revision}`,
          },
        })
      );
    });
  }
  return out;
}

const controller = (meta: any, kinds: string[]) =>
  (meta?.ownerReferences ?? []).find((ref: any) => ref.controller && kinds.includes(ref.kind));

/** A Deployment's rollouts from its ReplicaSets: each new revision against the one before. */
export function fromReplicaSets(target: ChangeTarget, replicaSets: any[], window: Window): Change[] {
  const revisions: Revisioned[] = [];
  for (const rs of replicaSets) {
    const owner = controller(rs.metadata, ["Deployment"]);
    const revision = Number(rs.metadata?.annotations?.[REVISION_ANNOTATION]);
    if (!owner?.uid || !Number.isFinite(revision) || revision <= 0) continue;
    revisions.push({
      owner: { kind: "Deployment", name: owner.name, uid: owner.uid },
      namespace: rs.metadata?.namespace ?? "",
      revision,
      created: rs.metadata?.creationTimestamp ?? "",
      template: cleanTemplate(rs.spec?.template),
      reused: !!rs.metadata?.annotations?.["deployment.kubernetes.io/revision-history"],
    });
  }
  return revisionChanges(target, revisions, window);
}

/** StatefulSet and DaemonSet rollouts from their ControllerRevisions. */
export function fromControllerRevisions(target: ChangeTarget, controllerRevisions: any[], window: Window): Change[] {
  const revisions: Revisioned[] = [];
  for (const cr of controllerRevisions) {
    const owner = controller(cr.metadata, ["StatefulSet", "DaemonSet"]);
    const revision = Number(cr.revision);
    if (!owner?.uid || !Number.isFinite(revision) || revision <= 0) continue;
    revisions.push({
      owner: { kind: owner.kind, name: owner.name, uid: owner.uid },
      namespace: cr.metadata?.namespace ?? "",
      revision,
      created: cr.metadata?.creationTimestamp ?? "",
      template: cleanTemplate(cr.data?.spec?.template),
      reused: false,
    });
  }
  return revisionChanges(target, revisions, window);
}

/* ------------------------------------------------------------- Helm -- */

export interface HelmRevisionInput extends HelmRevisionLike {
  updated?: string | null;
}

/** A Helm release's revisions: chart version and which values changed. */
export function fromHelmHistory(
  target: ChangeTarget,
  release: { name: string; namespace: string },
  history: HelmRevisionInput[],
  window: Window
): Change[] {
  const sorted = [...history].sort((a, b) => a.revision - b.revision);
  return sorted.flatMap((revision, index) => {
    if (!inWindow(revision.updated, window)) return [];
    const previous = sorted[index - 1];
    const failed = /failed/i.test(revision.status ?? "");
    return [
      make(target, {
        key: `helm:${release.namespace}/${release.name}:${revision.revision}`,
        at: revision.updated!,
        object: { kind: "HelmRelease", apiVersion: "helm.sh/v3", name: release.name, namespace: release.namespace },
        kind: "release",
        words: helmWords(previous, revision, diffFields),
        by: "helm",
        source: "helm",
        tone: failed ? "destructive" : undefined,
        diff: previous
          ? {
              before: previous.values ?? {},
              after: revision.values ?? {},
              beforeLabel: `Revision ${previous.revision} values`,
              afterLabel: `Revision ${revision.revision} values`,
            }
          : undefined,
      }),
    ];
  });
}

/* ---------------------------------------------------------- GitOps -- */

/** Argo CD syncs from each Application's `status.history`. */
export function fromArgoApplications(target: ChangeTarget, applications: any[], window: Window): Change[] {
  return applications.flatMap((app) => {
    const history: any[] = [...(app.status?.history ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
    return history.flatMap((entry, index) => {
      if (!inWindow(entry.deployedAt, window)) return [];
      const revision = entry.revision ?? entry.revisions?.[0];
      const previous = history[index - 1];
      const before = previous?.revision ?? previous?.revisions?.[0];
      const words: Phrase =
        before && before !== revision
          ? {
              text: `synced ${shortRevision(before)} → ${shortRevision(revision)}`,
              sentence: `Argo CD synced ${app.metadata?.name} from ${shortRevision(before)} to ${shortRevision(revision)}`,
            }
          : { text: `synced to ${shortRevision(revision)}`, sentence: `Argo CD synced ${app.metadata?.name} to ${shortRevision(revision)}` };
      return [
        make(target, {
          key: `argocd:${app.metadata?.uid}:${entry.id}`,
          at: entry.deployedAt,
          object: { kind: "Application", apiVersion: "argoproj.io/v1alpha1", name: app.metadata?.name, namespace: app.metadata?.namespace },
          kind: "release",
          words,
          by: "argocd-application-controller",
          source: "argocd",
        }),
      ];
    });
  });
}

/** Flux HelmRelease history (v2 `status.history`) and Kustomizations' applied revisions. */
export function fromFlux(target: ChangeTarget, helmReleases: any[], kustomizations: any[], window: Window): Change[] {
  const releases = helmReleases.flatMap((hr) => {
    const history: any[] = [...(Array.isArray(hr.status?.history) ? hr.status.history : [])].sort(
      (a, b) => Number(a.version) - Number(b.version)
    );
    return history.flatMap((snapshot, index) => {
      if (!inWindow(snapshot.lastDeployed, window)) return [];
      const previous = history[index - 1];
      const failed = /failed/i.test(snapshot.status ?? "");
      const words: Phrase =
        previous && previous.chartVersion !== snapshot.chartVersion
          ? {
              text: `chart ${previous.chartVersion} → ${snapshot.chartVersion}`,
              sentence: `Chart upgraded from ${previous.chartVersion} to ${snapshot.chartVersion}`,
            }
          : { text: `deployed ${snapshot.chartName} ${snapshot.chartVersion}`, sentence: `Deployed ${snapshot.chartName} ${snapshot.chartVersion}` };
      return [
        make(target, {
          key: `flux-hr:${hr.metadata?.uid}:${snapshot.version}`,
          at: snapshot.lastDeployed,
          object: { kind: "HelmRelease", apiVersion: hr.apiVersion, name: hr.metadata?.name, namespace: hr.metadata?.namespace },
          kind: "release",
          words: failed ? { text: `${words.text} · failed`, sentence: `${words.sentence}, which failed` } : words,
          by: "helm-controller",
          source: "flux",
          tone: failed ? "destructive" : undefined,
        }),
      ];
    });
  });
  const applied = kustomizations.flatMap((k) => {
    const revision = k.status?.lastAppliedRevision;
    const ready = (k.status?.conditions ?? []).find((c: any) => c.type === "Ready" && c.status === "True");
    if (!revision || !inWindow(ready?.lastTransitionTime, window)) return [];
    return [
      make(target, {
        key: `flux-ks:${k.metadata?.uid}:${revision}`,
        at: ready.lastTransitionTime,
        object: { kind: "Kustomization", apiVersion: k.apiVersion, name: k.metadata?.name, namespace: k.metadata?.namespace },
        kind: "release",
        words: { text: `applied ${shortRevision(revision)}`, sentence: `Flux applied ${shortRevision(revision)}` },
        by: "kustomize-controller",
        source: "flux",
      }),
    ];
  });
  return [...releases, ...applied];
}

/* --------------------------------------------------- managed fields -- */

const DATA_KINDS = new Set(["ConfigMap", "Secret"]);
/* A write this close to the creation is the creation. */
const CREATION_SLACK_MS = 5000;

/**
 * Who wrote each object last, from its managedFields: one change per
 * manager write in the window ("kubectl edit · changed replicas"), and its
 * creation. Objects may be metadata-only (PartialObjectMetadata).
 */
export function fromManagedFields(target: ChangeTarget, kind: string, objects: any[], window: Window): Change[] {
  return objects.flatMap((object) => {
    const meta = object.metadata ?? {};
    const ref = { kind, name: meta.name, namespace: meta.namespace || undefined, uid: meta.uid };
    const created = ms(meta.creationTimestamp);
    const out: Change[] = [];
    if (inWindow(meta.creationTimestamp, window)) {
      const creator = (meta.managedFields ?? []).find((e: any) => Math.abs(ms(e.time) - created) <= CREATION_SLACK_MS);
      out.push(
        make(target, {
          key: `created:${meta.uid}`,
          at: meta.creationTimestamp,
          object: ref,
          kind: "created",
          words: { text: "created", sentence: `${kind} ${meta.name} was created` },
          by: creator?.manager,
          source: "managed-fields",
        })
      );
    }
    for (const entry of meta.managedFields ?? []) {
      if (entry.subresource === "status" || !inWindow(entry.time, window)) continue;
      if (Math.abs(ms(entry.time) - created) <= CREATION_SLACK_MS) continue;
      const words = managedWords(kind, entry.fieldsV1);
      if (!words) continue;
      const topics = ownedTopics(entry.fieldsV1);
      const changeKind: ChangeKind = DATA_KINDS.has(kind)
        ? "config"
        : topics.every((t) => t === "replicas")
          ? "scale"
          : topics.every((t) => t === "restart")
            ? "restart"
            : topics.some((t) => ["image", "env", "resources", "probes", "the pod template", "restart"].includes(t))
              ? "template"
              : "spec";
      // The HPA scales through the scale subresource as the controller manager.
      const by = entry.subresource === "scale" && entry.manager === "kube-controller-manager" ? "horizontal-pod-autoscaler" : entry.manager;
      out.push(
        make(target, {
          key: `write:${meta.uid}:${entry.manager}:${entry.subresource ?? ""}:${entry.time}`,
          at: entry.time,
          object: ref,
          kind: changeKind,
          words: DATA_KINDS.has(kind) ? { text: words.text, sentence: `${kind} ${meta.name}: ${words.text}` } : words,
          by,
          source: "managed-fields",
        })
      );
    }
    return out;
  });
}

/* ------------------------------------------------ pods, nodes, events -- */

/** Each container's last restart (from `lastState`). */
export function fromPods(target: ChangeTarget, pods: any[], window: Window): Change[] {
  return pods.flatMap((pod) =>
    [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].flatMap((status: any) => {
      const terminated = status.lastState?.terminated;
      if (!terminated || !inWindow(terminated.finishedAt, window)) return [];
      return [
        make(target, {
          key: `restart:${pod.metadata?.uid}:${status.name}:${terminated.finishedAt}`,
          at: terminated.finishedAt,
          object: { kind: "Pod", name: pod.metadata?.name, namespace: pod.metadata?.namespace, uid: pod.metadata?.uid },
          kind: "crash",
          words: restartWords(terminated, status.restartCount ?? 0),
          by: "kubelet",
          source: "pods",
          tone: "warning",
        }),
      ];
    })
  );
}

/* Conditions that flip right after a node joins say nothing. */
const NODE_BOOT_MS = 5 * MINUTE;

const nodeProblem = (type: string, status: string): StatusTone | undefined =>
  (type === "Ready" && status !== "True") || (type !== "Ready" && status === "True") ? "warning" : undefined;

/** Each node condition's last transition. */
export function fromNodes(target: ChangeTarget, nodes: any[], window: Window): Change[] {
  return nodes.flatMap((node) => {
    const created = ms(node.metadata?.creationTimestamp);
    return (node.status?.conditions ?? []).flatMap((condition: any) => {
      const at = condition.lastTransitionTime;
      if (!inWindow(at, window) || ms(at) - created < NODE_BOOT_MS) return [];
      const words = conditionWords(condition.type, condition.status);
      if (!words) return [];
      return [
        make(target, {
          key: `condition:${node.metadata?.uid}:${condition.type}:${at}`,
          at,
          object: { kind: "Node", name: node.metadata?.name, uid: node.metadata?.uid },
          kind: "condition",
          words,
          by: "kubelet",
          source: "nodes",
          tone: nodeProblem(condition.type, condition.status),
        }),
      ];
    });
  });
}

/* Normal events worth a line (see the recorder's list too). */
const NORMAL_REASONS = new Set([
  "SuccessfulRescale",
  "NodeNotReady",
  "NodeReady",
  "Rebooted",
  "RemovingNode",
  "RegisteredNode",
  "NodeNotSchedulable",
  "NodeSchedulable",
  "TriggeredScaleUp",
  "ScaleDown",
  "Preempted",
  "Evicted",
]);

const NODE_REASONS = new Set(["NodeNotReady", "NodeReady", "Rebooted", "RemovingNode", "RegisteredNode", "NodeNotSchedulable", "NodeSchedulable"]);

const eventKind = (reason: string): ChangeKind =>
  reason === "SuccessfulRescale" ? "scale" : NODE_REASONS.has(reason) ? "condition" : "event";

/** Warnings, scaling and node events. */
export function fromEvents(target: ChangeTarget, events: any[], window: Window): Change[] {
  return events.flatMap((event) => {
    const reason = event.reason ?? "";
    if (event.type !== "Warning" && !NORMAL_REASONS.has(reason)) return [];
    const at = event.lastTimestamp || event.series?.lastObservedTime || event.eventTime || event.metadata?.creationTimestamp;
    if (!inWindow(at, window)) return [];
    const involved = event.involvedObject ?? event.regarding ?? {};
    return [
      make(target, {
        key: `event:${event.metadata?.uid}`,
        at,
        object: { kind: involved.kind, name: involved.name, namespace: involved.namespace || event.metadata?.namespace || undefined, uid: involved.uid },
        kind: eventKind(reason),
        words: eventWords({ type: event.type, reason, message: event.message ?? event.note, count: event.series?.count ?? event.count }),
        by: event.source?.component || event.reportingComponent || event.reportingController || undefined,
        source: "events",
        tone: event.type === "Warning" ? "warning" : undefined,
        reason,
      }),
    ];
  });
}

/* ------------------------------------------------------- recorded -- */

/** A record of the backend recorder (src-tauri/src/changes/record.rs). */
export interface ChangeRecord {
  id: string;
  at: string;
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
  action: "created" | "updated" | "deleted" | "condition" | "event";
  by?: string;
  fields?: FieldChange[];
  more?: boolean;
  keys?: { added?: string[]; removed?: string[]; changed?: string[] };
  event?: { type: string; reason: string; message: string; count: number; firstAt?: string };
  condition?: { type: string; from?: string; to: string; reason?: string; message?: string };
  count?: number;
}

const updateKind = (fields: FieldChange[]): ChangeKind => {
  if (fields.length && fields.every((f) => f.path.length === 1 && f.path[0] === "replicas")) return "scale";
  if (fields.length && fields.every(isRestart)) return "restart";
  return fields.some((f) => f.path[0] === "template") ? "template" : "spec";
};

/** The recorder's records as changes. */
export function fromRecords(target: ChangeTarget, records: ChangeRecord[]): Change[] {
  return records.flatMap((record): Change[] => {
    const object = { kind: record.kind, name: record.name, namespace: record.namespace || undefined, uid: record.uid || undefined };
    const base = { at: record.at, object, by: record.by, source: "recorded" as const, recorded: true };
    switch (record.action) {
      case "event": {
        const event = record.event;
        if (!event) return [];
        return [
          make(target, {
            ...base,
            key: record.id,
            kind: eventKind(event.reason),
            words: eventWords(event),
            tone: event.type === "Warning" ? "warning" : undefined,
            reason: event.reason,
          }),
        ];
      }
      case "condition": {
        const condition = record.condition;
        const words = condition && conditionWords(condition.type, condition.to);
        if (!condition || !words) return [];
        return [
          make(target, { ...base, key: `rec:${record.id}`, kind: "condition", words, tone: nodeProblem(condition.type, condition.to) }),
        ];
      }
      case "created":
        return [make(target, { ...base, key: `rec:${record.id}`, kind: "created", words: { text: "created", sentence: `${record.kind} ${record.name} was created` } })];
      case "deleted":
        return [
          make(target, {
            ...base,
            key: `rec:${record.id}`,
            kind: "deleted",
            words: { text: "deleted", sentence: `${record.kind} ${record.name} was deleted` },
            tone: DATA_KINDS.has(record.kind) ? "warning" : undefined,
          }),
        ];
      case "updated": {
        if (record.keys) {
          return [make(target, { ...base, key: `rec:${record.id}`, kind: "config", words: keyWords(record.kind, record.name, record.keys) })];
        }
        const fields = record.fields ?? [];
        const { before, after } = sides(fields);
        return [
          make(target, {
            ...base,
            key: `rec:${record.id}`,
            kind: updateKind(fields),
            words: fieldWords(fields, record.more),
            diff: fields.length ? { before, after, beforeLabel: "Before", afterLabel: "After" } : undefined,
          }),
        ];
      }
    }
  });
}
