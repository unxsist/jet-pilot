/*
 * The change that most likely caused a problem: the newest change to the
 * object or its owners (a new image, an edited ConfigMap it mounts, a Helm
 * upgrade) shortly before the problem started. The change timeline
 * (@/lib/changes) answers it; null when nothing explains the problem.
 */
import type { KubeTarget } from "@/lib/kubeApi";
import type { ObjectRef } from "@/lib/resources/kinds";

export interface ChangeSummary {
  /** When the change happened (ISO 8601). */
  at: string;
  /** What changed: the object itself, its owner or something it uses. */
  object: ObjectRef;
  /** One sentence: "Image changed from api:1.4.2 to api:1.5.0." */
  summary: string;
  /** Who made it when known: "helm", "argocd-application-controller", "kubectl-edit". */
  by?: string;
}

export type LikelyCause = (
  target: KubeTarget,
  object: ObjectRef,
  /** When the problem started (ISO 8601); changes after it don't count. */
  since?: string
) => Promise<ChangeSummary | null>;

export const likelyCause: LikelyCause = async () => null;
