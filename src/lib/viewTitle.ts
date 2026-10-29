/** Titles of views (split view pane headers, pop-out window titles). */
import { formatResourceKind } from "@/lib/utils";

const PAGE_TITLES: Record<string, { title: string; icon: string }> = {
  Pods: { title: "Pods", icon: "pods" },
  ClustersHub: { title: "Clusters", icon: "clustershub" },
  ClusterOverview: { title: "Resource Graph", icon: "diagram" },
  GitOps: { title: "GitOps", icon: "gitops" },
  AccessReview: { title: "Access review", icon: "rolebindings" },
  HelmReleases: { title: "Helm releases", icon: "helm" },
  HelmChartsPage: { title: "Helm charts", icon: "helm" },
};

/**
 * Title and icon of the view at a route (pane headers, window titles):
 * "Pods", "Deployments", "Resource Graph"…
 */
export function viewTitle(route: {
  name?: unknown;
  query?: Record<string, unknown>;
}): { title: string; icon: string } {
  const page = PAGE_TITLES[String(route.name ?? "")];
  if (page) return page;
  const kind = route.query?.kind;
  const resource = route.query?.resource;
  if (typeof kind === "string" && kind) {
    return {
      title: formatResourceKind(kind),
      icon: typeof resource === "string" && resource ? resource : kind,
    };
  }
  return { title: "View", icon: "" };
}

