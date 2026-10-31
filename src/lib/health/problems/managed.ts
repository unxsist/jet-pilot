/*
 * Who manages an object, from the labels and annotations its tools leave
 * on it (pure, unit tested): Argo CD (annotation or label tracking), Flux
 * (a Kustomization or HelmRelease) or Helm. A fix applied to such an
 * object drifts from its source and is undone on the next sync or
 * upgrade, so the Problems panel says so before changing it.
 *
 * `app.kubernetes.io/instance` alone doesn't count: Helm charts set it
 * too, so it can't tell Argo CD's label tracking from a chart's label.
 */
export interface Manager {
  tool: "argocd" | "flux" | "helm";
  /** The Argo CD app, Flux object or Helm release. */
  name: string;
  namespace?: string;
  /** Flux: "Kustomization" or "HelmRelease". */
  kind?: string;
}

interface Labelled {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
}

export function managerOf(object: Labelled | null | undefined): Manager | null {
  const labels = object?.metadata?.labels ?? {};
  const annotations = object?.metadata?.annotations ?? {};

  // <app>:<group>/<kind>:<namespace>/<name>, the app possibly as <namespace>_<app>.
  const tracking = annotations["argocd.argoproj.io/tracking-id"];
  if (tracking) {
    const app = tracking.split(":")[0]!;
    const [namespace, name] = app.includes("_") ? app.split("_", 2) : [undefined, app];
    return { tool: "argocd", name: name!, ...(namespace ? { namespace } : {}) };
  }
  if (labels["argocd.argoproj.io/instance"]) return { tool: "argocd", name: labels["argocd.argoproj.io/instance"] };

  const helmRelease = labels["helm.toolkit.fluxcd.io/name"];
  if (helmRelease) return { tool: "flux", kind: "HelmRelease", name: helmRelease, namespace: labels["helm.toolkit.fluxcd.io/namespace"] };
  const kustomization = labels["kustomize.toolkit.fluxcd.io/name"];
  if (kustomization) return { tool: "flux", kind: "Kustomization", name: kustomization, namespace: labels["kustomize.toolkit.fluxcd.io/namespace"] };

  const release = annotations["meta.helm.sh/release-name"];
  if (release) return { tool: "helm", name: release, namespace: annotations["meta.helm.sh/release-namespace"] };
  return null;
}

/** "Managed by Argo CD app shop.", "Managed by Helm release payments-api." */
export function managedWords(manager: Manager): { title: string; detail: string } {
  switch (manager.tool) {
    case "argocd":
      return {
        title: `Managed by Argo CD app ${manager.name}`,
        detail: "A change here is reverted on the next sync. Fix it in Git.",
      };
    case "flux":
      return {
        title: `Managed by Flux ${manager.kind ?? "Kustomization"} ${manager.name}`,
        detail: "A change here is reverted on the next reconcile. Fix it in Git.",
      };
    case "helm":
      return {
        title: `Managed by Helm release ${manager.name}`,
        detail: "A change here is undone by the next upgrade. Fix it in the chart's values.",
      };
  }
}
