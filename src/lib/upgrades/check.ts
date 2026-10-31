/*
 * Runs the Upgrades check for one cluster: its version and support, the
 * deprecated APIs it still uses, its add-ons and its nodes. Cluster-wide
 * where the user may read cluster-wide, else in the selected namespaces.
 * Everything compares against data bundled with the app; nothing here
 * leaves the cluster's own API.
 */
import { invoke } from "@tauri-apps/api/core";
import { kubeGet, kubeRequest } from "@/lib/kubeApi";
import { flattenResources, getDiscoveryService, runLimited } from "@/lib/discovery";
import type { HealthTarget } from "@/lib/health/tabs";
import type { ProviderId } from "@/lib/clusters/provider";
import { allNamespaces, listIn } from "@/lib/health/checks/collect";
import { addonStatus, componentVersions, findAddons, type AddonStatus, type HelmReleaseInfo, type WorkloadInfo } from "./addons";
import { apiFindings, kindsToScan, usesOfObject, type ApiFinding, type ApiUse } from "./apis";
import { nextMinorOn, platformOf, supportOf, type Platform, type Support } from "./support";
import { addMinors, compareMinor, minorOf } from "./versions";

interface ReleaseApis extends HelmReleaseInfo {
  revision: number;
  objects: { apiVersion: string; kind: string; name: string }[];
  error: string | null;
}

export interface NodeVersions {
  total: number;
  /** Kubelet minors, newest first. */
  minors: { minor: string; count: number }[];
  /** Nodes too old for the next control plane minor (more than the kubelet skew allows). */
  tooOld: number;
}

export interface UpgradeReport {
  /** The API server's gitVersion. */
  version: string | null;
  platform: Platform;
  support: Support | null;
  /** The next minor the platform offers. */
  next: string | null;
  apis: ApiFinding[];
  /** Helm releases and kinds that were looked at. */
  scanned: { releases: number; kinds: number };
  addons: AddonStatus[];
  nodes: NodeVersions | null;
  /** What couldn't be read, in words. */
  skipped: string[];
  /** Read in these namespaces only (no cluster-wide access). */
  namespaces: string[] | null;
}

const PARTIAL_METADATA = "application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io,application/json";
const forbidden = (error: unknown) => (error as { code?: number })?.code === 403;

/**
 * Kubelets may be three minors older than the API server (two before
 * 1.28): count the nodes the next control plane minor would leave behind.
 */
export function nodeVersions(nodes: any[], clusterMinor: string | null, next: string | null): NodeVersions {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const minor = minorOf(node?.status?.nodeInfo?.kubeletVersion);
    if (minor) counts.set(minor, (counts.get(minor) ?? 0) + 1);
  }
  const minors = [...counts.entries()]
    .map(([minor, count]) => ({ minor, count }))
    .sort((a, b) => compareMinor(b.minor, a.minor));
  let tooOld = 0;
  if (next && clusterMinor) {
    const skew = compareMinor(next, "1.28") >= 0 ? 3 : 2;
    const oldest = addMinors(next, -skew);
    tooOld = minors.filter((m) => compareMinor(m.minor, oldest) < 0).reduce((sum, m) => sum + m.count, 0);
  }
  return { total: nodes.length, minors, tooOld };
}

export async function checkUpgrades(target: HealthTarget, provider?: ProviderId | null): Promise<UpgradeReport> {
  const skipped: string[] = [];
  const kube = { context: target.context, kubeConfig: target.kubeConfig || undefined };
  const versionInfo = await kubeGet<{ gitVersion?: string }>(kube, "/version");
  const version = versionInfo?.gitVersion ?? null;
  const minor = minorOf(version);

  const nodes = await listIn(target, "v1", "nodes").catch(() => {
    skipped.push("nodes");
    return [] as any[];
  });
  const platform = platformOf({ version, provider, nodeLabels: nodes[0]?.metadata?.labels });
  const support = supportOf(platform, version);
  const next = minor ? nextMinorOn(platform, minor) : null;

  /* Cluster-wide first; without that access, the selected namespaces. */
  let namespaces = ["all"];
  const scoped = async <T>(load: (namespaces: string[]) => Promise<T>): Promise<T> => {
    try {
      return await load(namespaces);
    } catch (error) {
      if (!forbidden(error) || allNamespaces(target.namespaces)) throw error;
      namespaces = target.namespaces;
      return load(namespaces);
    }
  };
  const lenient = async <T>(what: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch {
      skipped.push(what);
      return fallback;
    }
  };

  const [deployments, daemonsets, statefulsets] = await Promise.all(
    (["deployments", "daemonsets", "statefulsets"] as const).map((resource) =>
      lenient(resource, () => scoped((ns) => listIn(target, "apps/v1", resource, ns)), [] as any[])
    )
  );
  const releases = await lenient(
    "Helm releases",
    () =>
      scoped((ns) =>
        invoke<ReleaseApis[]>("helm_manifest_apis", {
          context: target.context,
          kubeConfig: target.kubeConfig || null,
          namespaces: ns,
        })
      ),
    [] as ReleaseApis[]
  );

  const workloads: WorkloadInfo[] = [
    ...deployments.map((o) => ({ kind: "Deployment", o })),
    ...daemonsets.map((o) => ({ kind: "DaemonSet", o })),
    ...statefulsets.map((o) => ({ kind: "StatefulSet", o })),
  ].map(({ kind, o }) => ({
    kind,
    name: o?.metadata?.name ?? "",
    namespace: o?.metadata?.namespace ?? "",
    labels: o?.metadata?.labels ?? {},
    images: (o?.spec?.template?.spec?.containers ?? []).map((c: any) => String(c?.image ?? "")),
  }));
  const found = findAddons(releases, workloads);

  /* Objects whose kinds have deprecated or removed API versions (metadata only). */
  const uses: ApiUse[] = [];
  const kinds = minor ? kindsToScan(minor) : [];
  const listed: Record<string, any[]> = { Deployment: deployments, DaemonSet: daemonsets, StatefulSet: statefulsets };
  const snapshot = await getDiscoveryService()
    .load(target.context, target.kubeConfig)
    .catch(() => null);
  const served = flattenResources(snapshot);
  const tasks = kinds.map(({ kind, groups }) => async () => {
    if (listed[kind]) return { kind, items: listed[kind] };
    const resource = served.find((r) => r.kind === kind && groups.includes(r.group) && r.verbs.includes("list"));
    if (!resource) return { kind, items: [] };
    const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;
    const scopes = resource.namespaced && !allNamespaces(namespaces) ? namespaces : [undefined];
    const lists = await Promise.all(
      scopes.map((namespace) => {
        const base = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
        const path = namespace ? `${base}/namespaces/${encodeURIComponent(namespace)}/${resource.name}` : `${base}/${resource.name}`;
        return kubeRequest<{ items?: any[] }>(kube, path, { accept: PARTIAL_METADATA });
      })
    );
    return { kind, items: lists.flatMap((l) => l?.items ?? []) };
  });
  for (const result of await runLimited(tasks, 4)) {
    if (result.status === "fulfilled") {
      for (const object of result.value.items) uses.push(...usesOfObject(result.value.kind, object));
    }
  }
  for (const release of releases) {
    for (const object of release.objects) {
      uses.push({
        apiVersion: object.apiVersion,
        kind: object.kind,
        name: object.name,
        source: { type: "helm", release: release.name, namespace: release.namespace },
      });
    }
  }

  return {
    version,
    platform,
    support,
    next,
    apis: apiFindings(uses, minor, componentVersions(found)),
    scanned: { releases: releases.length, kinds: kinds.length },
    addons: found.map((addon) => addonStatus(addon)),
    nodes: nodes.length ? nodeVersions(nodes, minor, next) : null,
    skipped,
    namespaces: allNamespaces(namespaces) ? null : namespaces,
  };
}
