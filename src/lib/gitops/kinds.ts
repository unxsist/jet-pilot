/*
 * The GitOps kinds (Flux, Argo CD) and their detection from API discovery.
 * Small on purpose: the navigation imports it at startup.
 */
import type { DiscoveredResource } from "@/lib/discovery";

export type Tool = "flux" | "argo";
export type DeliveryKind = "Kustomization" | "HelmRelease" | "Application";

export const TOOL_LABELS: Record<Tool, string> = { flux: "Flux", argo: "Argo CD" };

export interface WatchedKind {
  kind: string;
  plural: string;
  group: string;
  tool: Tool;
}

export const FLUX_SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const ARGO_GROUP = "argoproj.io";

/** The kinds the GitOps page lists. */
export const DELIVERY_KINDS: Record<DeliveryKind, WatchedKind> = {
  Kustomization: { kind: "Kustomization", plural: "kustomizations", group: "kustomize.toolkit.fluxcd.io", tool: "flux" },
  HelmRelease: { kind: "HelmRelease", plural: "helmreleases", group: "helm.toolkit.fluxcd.io", tool: "flux" },
  Application: { kind: "Application", plural: "applications", group: ARGO_GROUP, tool: "argo" },
};

/** Flux sources: their status explains many failures of the deliveries. */
export const SOURCE_KINDS: Record<string, WatchedKind> = {
  GitRepository: { kind: "GitRepository", plural: "gitrepositories", group: FLUX_SOURCE_GROUP, tool: "flux" },
  OCIRepository: { kind: "OCIRepository", plural: "ocirepositories", group: FLUX_SOURCE_GROUP, tool: "flux" },
  HelmRepository: { kind: "HelmRepository", plural: "helmrepositories", group: FLUX_SOURCE_GROUP, tool: "flux" },
  HelmChart: { kind: "HelmChart", plural: "helmcharts", group: FLUX_SOURCE_GROUP, tool: "flux" },
  Bucket: { kind: "Bucket", plural: "buckets", group: FLUX_SOURCE_GROUP, tool: "flux" },
};

export const WATCHED_KINDS: WatchedKind[] = [
  ...Object.values(DELIVERY_KINDS),
  ...Object.values(SOURCE_KINDS),
];

/** `plural.group`: the name the watch / kubectl resolve unambiguously. */
export const qualifiedName = (kind: WatchedKind) => `${kind.plural}.${kind.group}`;

export const groupOf = (apiVersion: string | undefined) =>
  apiVersion?.includes("/") ? apiVersion.split("/")[0]! : "";

export const isFluxGroup = (group: string) => group.endsWith(".toolkit.fluxcd.io");

/** The delivery kind of an object (Flux / Argo CD group checked), else null. */
export function deliveryKindOf(object: { kind?: string; apiVersion?: string } | null | undefined): DeliveryKind | null {
  const info = DELIVERY_KINDS[object?.kind as DeliveryKind];
  return info && groupOf(object?.apiVersion) === info.group ? (object!.kind as DeliveryKind) : null;
}

/* ------------------------------------------------------- detection -- */

export interface Detection {
  flux: boolean;
  argo: boolean;
  /** Watchable kinds served by the cluster, by kind. */
  served: Map<string, DiscoveredResource>;
}

/** Which GitOps tools (and kinds) a cluster's discovery shows. */
export function detectGitOps(resources: DiscoveredResource[]): Detection {
  const served = new Map<string, DiscoveredResource>();
  let flux = false;
  let argo = false;
  for (const resource of resources) {
    if (resource.name.includes("/")) continue;
    if (isFluxGroup(resource.group)) flux = true;
    if (resource.group === ARGO_GROUP && resource.kind === "Application") argo = true;
    const known = WATCHED_KINDS.find((k) => k.kind === resource.kind && k.group === resource.group);
    if (known) served.set(known.kind, resource);
  }
  return { flux, argo, served };
}
