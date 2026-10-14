/*
 * Friendly navigation for API groups: well-known projects get a human title
 * ("cert-manager", "Gateway API", "KEDA") and one section for all of their
 * groups (Flux's five toolkit groups are "Flux"), with their kinds in a
 * sensible order. Groups nobody knows keep their raw name; when there are
 * many, they share one "More resources" section.
 *
 * Pure (no Vue), unit tested; used by Navigation.vue.
 */
import { groupRank, type DiscoveredResource } from "./discovery";

export interface ApiProject {
  title: string;
  /** Exact groups, or `*.suffix` for every group below a domain. */
  groups: string[];
  /** Kinds in the section's order (others follow alphabetically). */
  kinds?: string[];
  /** Title when the groups also serve kinds outside `kinds`. */
  otherKindsTitle?: string;
}

/* Kept compact: the list is part of the startup bundle (the sidebar). */
export const API_PROJECTS: ApiProject[] = [
  {
    title: "cert-manager",
    groups: ["cert-manager.io", "*.cert-manager.io"],
    kinds: ["Certificate", "Issuer", "ClusterIssuer", "CertificateRequest", "Order", "Challenge"],
  },
  {
    title: "Gateway API",
    groups: ["gateway.networking.k8s.io", "gateway.networking.x-k8s.io"],
    kinds: ["Gateway", "HTTPRoute", "GRPCRoute", "GatewayClass"],
  },
  { title: "Karpenter", groups: ["karpenter.sh", "karpenter.k8s.aws", "karpenter.azure.com"], kinds: ["NodePool", "NodeClaim"] },
  { title: "KEDA", groups: ["keda.sh", "eventing.keda.sh"], kinds: ["ScaledObject", "ScaledJob", "TriggerAuthentication"] },
  {
    title: "External Secrets",
    groups: ["external-secrets.io", "*.external-secrets.io"],
    kinds: ["ExternalSecret", "SecretStore", "ClusterSecretStore"],
  },
  {
    title: "Prometheus Operator",
    groups: ["monitoring.coreos.com"],
    kinds: ["ServiceMonitor", "PodMonitor", "PrometheusRule"],
  },
  { title: "Istio", groups: ["*.istio.io"], kinds: ["VirtualService", "Gateway", "DestinationRule", "ServiceEntry"] },
  { title: "Velero", groups: ["velero.io"], kinds: ["Backup", "Schedule", "Restore"] },
  { title: "CloudNativePG", groups: ["postgresql.cnpg.io"], kinds: ["Cluster", "Pooler"] },
  {
    title: "Flux",
    groups: ["*.toolkit.fluxcd.io"],
    kinds: ["Kustomization", "HelmRelease", "GitRepository", "OCIRepository", "HelmRepository"],
  },
  {
    title: "Argo CD",
    groups: ["argoproj.io"],
    kinds: ["Application", "ApplicationSet", "AppProject"],
    // argoproj.io is shared by Argo Rollouts and Argo Workflows.
    otherKindsTitle: "Argo",
  },
  { title: "Crossplane", groups: ["*.crossplane.io"] },
  { title: "Kyverno", groups: ["kyverno.io", "*.kyverno.io", "wgpolicyk8s.io"], kinds: ["ClusterPolicy", "Policy"] },
  { title: "Cilium", groups: ["cilium.io"], kinds: ["CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy"] },
  { title: "Calico", groups: ["crd.projectcalico.org", "projectcalico.org", "operator.tigera.io"] },
  { title: "Traefik", groups: ["traefik.io", "traefik.containo.us"], kinds: ["IngressRoute", "Middleware"] },
  { title: "Longhorn", groups: ["longhorn.io"], kinds: ["Volume"] },
  { title: "Tekton", groups: ["tekton.dev", "*.tekton.dev"], kinds: ["Pipeline", "PipelineRun", "Task", "TaskRun"] },
  { title: "Knative", groups: ["*.knative.dev"], kinds: ["Service"] },
  { title: "Linkerd", groups: ["*.linkerd.io"] },
  { title: "Strimzi", groups: ["kafka.strimzi.io", "core.strimzi.io"], kinds: ["Kafka", "KafkaTopic"] },
  { title: "Elastic", groups: ["*.k8s.elastic.co"] },
  { title: "Rook Ceph", groups: ["ceph.rook.io"], kinds: ["CephCluster"] },
  { title: "OpenTelemetry", groups: ["opentelemetry.io"] },
  { title: "Grafana Operator", groups: ["grafana.integreatly.org"] },
  { title: "VictoriaMetrics", groups: ["operator.victoriametrics.com"] },
  { title: "Sealed Secrets", groups: ["bitnami.com"] },
  { title: "Secrets Store CSI", groups: ["secrets-store.csi.x-k8s.io"] },
  { title: "Cluster API", groups: ["cluster.x-k8s.io", "*.cluster.x-k8s.io"] },
  { title: "Kueue", groups: ["kueue.x-k8s.io"] },
  { title: "KubeVirt", groups: ["kubevirt.io", "*.kubevirt.io"] },
  { title: "Envoy Gateway", groups: ["gateway.envoyproxy.io"] },
  { title: "Contour", groups: ["projectcontour.io"] },
  { title: "NGINX", groups: ["k8s.nginx.org"] },
  { title: "Kong", groups: ["configuration.konghq.com"] },
  { title: "AWS Load Balancer", groups: ["elbv2.k8s.aws"] },
];

/* Groups served by Kubernetes itself (no CRD behind them). */
const BUILT_IN_GROUPS = new Set([
  "",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "internal.apiserver.k8s.io",
  "metrics.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
  "storagemigration.k8s.io",
]);

export const isBuiltInGroup = (group: string) => BUILT_IN_GROUPS.has(group);

const groupMatches = (pattern: string, group: string) =>
  pattern.startsWith("*.") ? group.endsWith(pattern.slice(1)) : group === pattern;

/** The well-known project an API group belongs to. */
export function projectOf(group: string): ApiProject | undefined {
  return API_PROJECTS.find((project) =>
    project.groups.some((pattern) => groupMatches(pattern, group))
  );
}

/** A project's kinds first, in its order; the rest alphabetically. */
export function sortProjectKinds<T extends { kind: string }>(
  project: Pick<ApiProject, "kinds">,
  resources: readonly T[]
): T[] {
  const order = project.kinds ?? [];
  const rank = (kind: string) => {
    const index = order.indexOf(kind);
    return index < 0 ? order.length : index;
  };
  return [...resources].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind)
  );
}

export interface NavSection<T extends DiscoveredResource = DiscoveredResource> {
  title: string;
  items: T[];
  /** The project, for command palette titles ("Velero Backups"). */
  project?: ApiProject;
  /**
   * "More resources": the long tail of unknown groups, folded until opened,
   * each item with its group.
   */
  tail: boolean;
}

export const MORE_RESOURCES = "More resources";

export interface GroupSectionOptions<T extends DiscoveredResource> {
  /**
   * The resources of a section worth listing (one per kind, not pinned,
   * ...), in any order.
   */
  visible: (resources: T[]) => T[];
  /** Order of resources in sections of unknown groups. */
  sort: (a: T, b: T) => number;
  /** At most this many unknown groups get a section of their own. */
  looseLimit?: number;
}

/**
 * Sections for the API groups outside the built-in navigation groups:
 * one per well-known project (alphabetically by title), then one per
 * unknown group (raw name), or a single "More resources" section when
 * there are more than `looseLimit` unknown groups.
 */
export function groupSections<T extends DiscoveredResource>(
  groups: Iterable<[string, T[]]>,
  options: GroupSectionOptions<T>
): NavSection<T>[] {
  const { visible, sort, looseLimit = 3 } = options;
  const byProject = new Map<ApiProject, T[]>();
  const loose: [string, T[]][] = [];
  for (const [group, resources] of groups) {
    const project = projectOf(group);
    if (project) byProject.set(project, [...(byProject.get(project) ?? []), ...resources]);
    else loose.push([group, resources]);
  }

  const projects = [...byProject].map(([project, resources]): NavSection<T> => {
    const items = sortProjectKinds(project, visible(resources));
    const known = project.kinds ?? [];
    const mixed =
      !!project.otherKindsTitle &&
      resources.some((r) => !r.name.includes("/") && !known.includes(r.kind));
    return {
      title: mixed ? project.otherKindsTitle! : project.title,
      items,
      project,
      tail: false,
    };
  });
  projects.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  const looseSections = loose
    .map(([group, resources]): NavSection<T> => ({
      title: group,
      items: [...visible(resources)].sort(sort),
      tail: false,
    }))
    .filter((section) => section.items.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title));

  const tail =
    looseSections.length > looseLimit
      ? [
          {
            title: MORE_RESOURCES,
            items: looseSections
              .flatMap((section) => section.items)
              .sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group)),
            tail: true,
          },
        ]
      : looseSections;

  return [...projects.filter((section) => section.items.length > 0), ...tail];
}

/** Command palette title of a section's item: "Velero Backups", "Tenants (platform.acme.dev)". */
export function commandTitle(section: NavSection, resource: DiscoveredResource, title: string) {
  if (section.project) return `${section.title} ${title}`;
  return section.tail ? `${title} (${resource.group})` : undefined;
}

/* Plurals whose list path is an app page ("/clusters" is the Clusters hub). */
const APP_PATHS = new Set(["clusters", "settings", "cluster-overview"]);

/**
 * The resource name (and path) of a list route: `plural`, or `plural.group`
 * when another group serves the same plural and wins the unqualified name
 * (the core and built-in groups first, then alphabetically, like the
 * backend and kubectl): Istio's `gateways` next to the Gateway API's,
 * Velero's `backups` next to CloudNativePG's. Also qualified when the plural
 * is an app page (CloudNativePG's `clusters`).
 */
export function listResourceName(
  resource: DiscoveredResource,
  all: readonly DiscoveredResource[],
  plural: string = resource.name
): string {
  const winner = all
    .filter((r) => r.name === resource.name && !r.name.includes("/"))
    .sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group)
    )[0];
  const shadowed = !!winner && winner.group !== resource.group;
  return shadowed || APP_PATHS.has(plural) ? `${plural}.${resource.group}` : plural;
}
