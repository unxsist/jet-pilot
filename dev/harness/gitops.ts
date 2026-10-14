/*
 * GitOps fixtures and mocks: Flux (Kustomizations, HelmReleases and their
 * sources) and Argo CD (Applications, an ApplicationSet, projects) in both
 * harness contexts, plus the raw API routes the GitOps actions use:
 *
 * - PATCH of Flux / Argo CD objects: merged into the fixture and pushed to
 *   the watchers, then the controller is played: a reconcile shows
 *   "Reconciling" and lands ~2 s later (failing deliveries fail again), a
 *   sync runs and succeeds, a refresh clears its annotation.
 * - GET of single objects (opening a delivered resource looks up its uid).
 *
 * prod-eu-west-1 runs Flux and Argo CD with deliveries in every state
 * (unhealthy, source failing, stalled, waiting, reconciling, suspended,
 * out of sync, degraded, syncing); staging-us-east-2 runs Flux, all
 * healthy. `?scenario=no-gitops` hides the Flux and Argo CD API groups.
 */
import { API_GROUPS, CLUSTERS, CONTEXTS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";

const NOW = Date.now();
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/* Deterministic hex "commits" per name. */
const sha = (seed: string, length = 40) => {
  let h = 2166136261;
  let out = "";
  while (out.length < length) {
    for (const ch of seed + out.length) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
};

let uidCounter = 0;
const meta = (name: string, namespace: string, extra: Record<string, unknown> = {}) => ({
  name,
  namespace,
  uid: `90000000-6c1d-4e2f-8a3b-${(++uidCounter).toString(16).padStart(12, "0")}`,
  generation: 3,
  creationTimestamp: ago(60 * DAY),
  labels: { "kustomize.toolkit.fluxcd.io/name": "flux-system", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" },
  ...extra,
});

const cond = (type: string, status: string, reason: string, message: string, since: number) => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: ago(since),
  observedGeneration: 3,
});

const ready = (message: string, since: number) => [cond("Ready", "True", "ReconciliationSucceeded", message, since)];

/* ------------------------------------------------------------ Flux -- */

const FLUX = "flux-system";
const gitRepository = (name: string, url: string, branch: string, opts: { failing?: string; since?: number } = {}) => {
  const revision = `${branch}@sha1:${sha(name)}`;
  return {
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "GitRepository",
    metadata: meta(name, FLUX),
    spec: { interval: "1m0s", url, ref: { branch }, secretRef: { name: `${name}-auth` }, timeout: "60s" },
    status: {
      observedGeneration: 3,
      conditions: opts.failing
        ? [
            cond("Ready", "False", "GitOperationFailed", opts.failing, opts.since ?? 40 * MIN),
            cond("FetchFailed", "True", "GitOperationFailed", opts.failing, opts.since ?? 40 * MIN),
          ]
        : [cond("Ready", "True", "Succeeded", `stored artifact for revision '${revision}'`, opts.since ?? 3 * HOUR)],
      artifact: opts.failing
        ? undefined
        : { revision, digest: `sha256:${sha(`${name}-digest`, 64)}`, lastUpdateTime: ago(3 * MIN), path: `gitrepository/${FLUX}/${name}/${sha(name)}.tar.gz` },
    },
  };
};

const ociRepository = (name: string, url: string, tag: string) => {
  const revision = `${tag}@sha256:${sha(name, 64)}`;
  return {
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "OCIRepository",
    metadata: meta(name, FLUX),
    spec: { interval: "5m0s", url, ref: { tag } },
    status: {
      observedGeneration: 3,
      conditions: [cond("Ready", "True", "Succeeded", `stored artifact for digest '${revision}'`, 2 * DAY)],
      artifact: { revision, digest: `sha256:${sha(name, 64)}`, lastUpdateTime: ago(2 * DAY) },
    },
  };
};

const helmRepository = (name: string, url: string, oci = false) => ({
  apiVersion: "source.toolkit.fluxcd.io/v1",
  kind: "HelmRepository",
  metadata: meta(name, FLUX),
  spec: { interval: "1h0m0s", url, ...(oci ? { type: "oci" } : {}) },
  status: oci
    ? { observedGeneration: 3 }
    : {
        observedGeneration: 3,
        conditions: [cond("Ready", "True", "Succeeded", `stored artifact: revision 'sha256:${sha(name, 64)}'`, 6 * HOUR)],
        artifact: { revision: `sha256:${sha(name, 64)}`, lastUpdateTime: ago(22 * MIN) },
      },
});

const helmChart = (release: string, chart: string, version: string, repository: string) => ({
  apiVersion: "source.toolkit.fluxcd.io/v1",
  kind: "HelmChart",
  metadata: meta(`${FLUX}-${release}`, FLUX),
  spec: { chart, version, sourceRef: { kind: "HelmRepository", name: repository }, interval: "1h0m0s" },
  status: {
    observedGeneration: 3,
    conditions: [cond("Ready", "True", "ChartPullSucceeded", `pulled '${chart}' chart with version '${version}'`, 3 * DAY)],
    artifact: { revision: version, lastUpdateTime: ago(3 * DAY) },
  },
});

interface Entry {
  ns: string;
  name: string;
  group?: string;
  kind: string;
  v?: string;
}
const inventory = (entries: Entry[]) => ({
  entries: entries.map((e) => ({ id: `${e.ns}_${e.name}_${e.group ?? ""}_${e.kind}`, v: e.v ?? "v1" })),
});

interface KustomizationSpec {
  name: string;
  path: string;
  source?: { kind: string; name: string };
  dependsOn?: string[];
  targetNamespace?: string;
  conditions: any[];
  revision?: string;
  entries?: Entry[];
  suspend?: boolean;
  wait?: boolean;
  generation?: number;
}

const kustomization = (k: KustomizationSpec) => ({
  apiVersion: "kustomize.toolkit.fluxcd.io/v1",
  kind: "Kustomization",
  metadata: { ...meta(k.name, FLUX), generation: k.generation ?? 3 },
  spec: {
    interval: "10m0s",
    retryInterval: "2m0s",
    timeout: "5m0s",
    path: k.path,
    prune: true,
    sourceRef: k.source ?? { kind: "GitRepository", name: "fleet" },
    ...(k.dependsOn ? { dependsOn: k.dependsOn.map((name) => ({ name })) } : {}),
    ...(k.targetNamespace ? { targetNamespace: k.targetNamespace } : {}),
    ...(k.wait ? { wait: true } : {}),
    ...(k.suspend ? { suspend: true } : {}),
  },
  status: {
    observedGeneration: 3,
    conditions: k.conditions,
    ...(k.revision ? { lastAppliedRevision: k.revision, lastAttemptedRevision: k.revision } : {}),
    ...(k.entries ? { inventory: inventory(k.entries) } : {}),
  },
});

interface HelmReleaseSpec {
  name: string;
  namespace: string;
  chart: string;
  version: string;
  repository: string;
  conditions: any[];
  deployed: number;
  status?: string;
}

const helmRelease = (h: HelmReleaseSpec) => ({
  apiVersion: "helm.toolkit.fluxcd.io/v2",
  kind: "HelmRelease",
  metadata: meta(h.name, FLUX),
  spec: {
    interval: "30m0s",
    releaseName: h.name,
    targetNamespace: h.namespace,
    chart: { spec: { chart: h.chart, version: h.version.replace(/\.\d+$/, ".x"), sourceRef: { kind: "HelmRepository", name: h.repository } } },
    install: { remediation: { retries: 3 } },
    upgrade: { remediation: { retries: 3 } },
  },
  status: {
    observedGeneration: 3,
    helmChart: `${FLUX}/${FLUX}-${h.name}`,
    conditions: h.conditions,
    lastAttemptedRevision: h.version,
    history: [
      {
        name: h.name,
        namespace: h.namespace,
        chartName: h.chart,
        chartVersion: h.version,
        version: 4,
        status: h.status ?? "deployed",
        firstDeployed: ago(90 * DAY),
        lastDeployed: ago(h.deployed),
        digest: `sha256:${sha(h.name, 64)}`,
      },
    ],
  },
});

const fleetRevision = `main@sha1:${sha("fleet")}`;

function fluxProd() {
  const payments: Entry[] = [
    { ns: "", name: "payments", kind: "Namespace" },
    { ns: "payments", name: "payments-api", kind: "ServiceAccount" },
    { ns: "payments", name: "payments-worker", kind: "ServiceAccount" },
    { ns: "payments", name: "payments-config", kind: "ConfigMap" },
    { ns: "payments", name: "payments-api", kind: "Service" },
    { ns: "payments", name: "ledger", kind: "Service" },
    { ns: "payments", name: "payments-api", group: "apps", kind: "Deployment" },
    { ns: "payments", name: "payments-worker", group: "apps", kind: "Deployment" },
    { ns: "payments", name: "ledger", group: "apps", kind: "Deployment" },
    { ns: "payments", name: "payments-api", group: "autoscaling", kind: "HorizontalPodAutoscaler", v: "v2" },
    { ns: "payments", name: "payments-api", group: "policy", kind: "PodDisruptionBudget" },
    { ns: "payments", name: "payments-api", group: "networking.k8s.io", kind: "Ingress" },
  ];
  const infra: Entry[] = [
    { ns: "", name: "ingress-nginx", kind: "Namespace" },
    { ns: "", name: "cert-manager", kind: "Namespace" },
    { ns: "", name: "monitoring", kind: "Namespace" },
    { ns: FLUX, name: "ingress-nginx", group: "helm.toolkit.fluxcd.io", kind: "HelmRelease", v: "v2" },
    { ns: FLUX, name: "cert-manager", group: "helm.toolkit.fluxcd.io", kind: "HelmRelease", v: "v2" },
    { ns: FLUX, name: "kube-prometheus-stack", group: "helm.toolkit.fluxcd.io", kind: "HelmRelease", v: "v2" },
    { ns: FLUX, name: "ingress-nginx", group: "source.toolkit.fluxcd.io", kind: "HelmRepository" },
    { ns: FLUX, name: "jetstack", group: "source.toolkit.fluxcd.io", kind: "HelmRepository" },
    { ns: FLUX, name: "prometheus-community", group: "source.toolkit.fluxcd.io", kind: "HelmRepository" },
  ];
  const applied = `Applied revision: ${fleetRevision}`;
  return {
    gitrepositories: [
      gitRepository("fleet", "https://github.com/acme/fleet.git", "main"),
      gitRepository("edge-config", "ssh://git@github.com/acme/edge-config", "main", {
        failing:
          "failed to checkout and determine revision: unable to clone 'ssh://git@github.com/acme/edge-config': ssh: handshake failed: ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain",
        since: 47 * MIN,
      }),
    ],
    ocirepositories: [ociRepository("tenants", "oci://ghcr.io/acme/manifests/tenants", "v1.4.0")],
    helmrepositories: [
      helmRepository("ingress-nginx", "https://kubernetes.github.io/ingress-nginx"),
      helmRepository("jetstack", "https://charts.jetstack.io"),
      helmRepository("prometheus-community", "https://prometheus-community.github.io/helm-charts"),
    ],
    helmcharts: [
      helmChart("ingress-nginx", "ingress-nginx", "4.11.1", "ingress-nginx"),
      helmChart("cert-manager", "cert-manager", "v1.15.1", "jetstack"),
      helmChart("kube-prometheus-stack", "kube-prometheus-stack", "61.3.2", "prometheus-community"),
    ],
    kustomizations: [
      kustomization({
        name: "flux-system",
        path: "./clusters/prod",
        conditions: ready(applied, 2 * HOUR),
        revision: fleetRevision,
        entries: [
          { ns: "", name: FLUX, kind: "Namespace" },
          { ns: FLUX, name: "fleet", group: "source.toolkit.fluxcd.io", kind: "GitRepository" },
          { ns: FLUX, name: "flux-system", group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
          { ns: FLUX, name: "infra-controllers", group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
          { ns: FLUX, name: "payments", group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
        ],
      }),
      kustomization({ name: "infra-controllers", path: "./infrastructure/controllers", conditions: ready(applied, 2 * HOUR), revision: fleetRevision, entries: infra, wait: true }),
      kustomization({
        name: "infra-configs",
        path: "./infrastructure/configs",
        dependsOn: ["infra-controllers"],
        conditions: ready(applied, 2 * HOUR),
        revision: fleetRevision,
        entries: [
          { ns: "", name: "letsencrypt", group: "cert-manager.io", kind: "ClusterIssuer" },
          { ns: "ingress-nginx", name: "ingress-nginx-controller", kind: "ConfigMap" },
        ],
      }),
      kustomization({
        name: "payments",
        path: "./apps/payments/prod",
        dependsOn: ["infra-configs"],
        targetNamespace: "payments",
        wait: true,
        conditions: [
          cond(
            "Ready",
            "False",
            "HealthCheckFailed",
            `Health check failed after 5m0s: timeout waiting for: [Deployment/payments/payments-worker status: 'InProgress']`,
            14 * MIN
          ),
          cond("Healthy", "False", "HealthCheckFailed", "Health check failed after 5m0s: timeout waiting for: [Deployment/payments/payments-worker status: 'InProgress']", 14 * MIN),
        ],
        revision: fleetRevision,
        entries: payments,
      }),
      kustomization({
        name: "payments-jobs",
        path: "./apps/payments-jobs/prod",
        dependsOn: ["payments"],
        targetNamespace: "payments",
        conditions: [cond("Ready", "False", "DependencyNotReady", "Dependencies do not meet ready condition, retrying in 30s", 13 * MIN)],
        revision: `main@sha1:${sha("payments-jobs-old")}`,
        entries: [
          { ns: "payments", name: "db-backup", group: "batch", kind: "CronJob" },
          { ns: "payments", name: "postgres-credentials", kind: "Secret" },
        ],
      }),
      kustomization({
        name: "platform-flags",
        path: "./apps/platform/feature-flags",
        targetNamespace: "platform",
        generation: 4,
        conditions: [
          cond("Reconciling", "True", "Progressing", `Detecting drift for revision ${fleetRevision} with a timeout of 5m0s`, 20),
          cond("Ready", "Unknown", "Progressing", "Reconciliation in progress", 20),
        ],
        revision: fleetRevision,
        entries: [
          { ns: "platform", name: "feature-flags", group: "apps", kind: "Deployment" },
          { ns: "platform", name: "feature-flags", group: "gateway.networking.k8s.io", kind: "HTTPRoute" },
        ],
      }),
      kustomization({
        name: "tenants",
        path: "./",
        source: { kind: "OCIRepository", name: "tenants" },
        conditions: ready(`Applied revision: v1.4.0@sha256:${sha("tenants", 64)}`, 2 * DAY),
        revision: `v1.4.0@sha256:${sha("tenants", 64)}`,
        entries: [
          { ns: "", name: "team-search", kind: "Namespace" },
          { ns: "", name: "team-billing", kind: "Namespace" },
          { ns: "team-search", name: "team-search-quota", kind: "ResourceQuota" },
        ],
      }),
      kustomization({
        name: "edge-config",
        path: "./prod",
        source: { kind: "GitRepository", name: "edge-config" },
        conditions: [cond("Ready", "False", "ArtifactFailed", "Source artifact not found, retrying in 30s", 47 * MIN)],
        revision: `main@sha1:${sha("edge-old")}`,
      }),
      kustomization({
        name: "ingress-config",
        path: "./infrastructure/ingress",
        suspend: true,
        conditions: ready(`Applied revision: main@sha1:${sha("fleet-old")}`, 9 * DAY),
        revision: `main@sha1:${sha("fleet-old")}`,
      }),
      kustomization({
        name: "monitoring-config",
        path: "./monitoring/configs",
        dependsOn: ["infra-controllers"],
        conditions: ready(applied, 2 * HOUR),
        revision: fleetRevision,
        entries: [
          { ns: "monitoring", name: "grafana-dashboards", kind: "ConfigMap" },
          { ns: "monitoring", name: "grafana", group: "networking.k8s.io", kind: "Ingress" },
        ],
      }),
    ],
    helmreleases: [
      helmRelease({
        name: "ingress-nginx",
        namespace: "ingress-nginx",
        chart: "ingress-nginx",
        version: "4.11.1",
        repository: "ingress-nginx",
        deployed: 88 * DAY,
        conditions: ready("Helm upgrade succeeded for release ingress-nginx/ingress-nginx.v4 with chart ingress-nginx@4.11.1", 88 * DAY),
      }),
      helmRelease({
        name: "cert-manager",
        namespace: "cert-manager",
        chart: "cert-manager",
        version: "v1.15.1",
        repository: "jetstack",
        deployed: 40 * DAY,
        conditions: ready("Helm upgrade succeeded for release cert-manager/cert-manager.v4 with chart cert-manager@v1.15.1", 40 * DAY),
      }),
      helmRelease({
        name: "kube-prometheus-stack",
        namespace: "monitoring",
        chart: "kube-prometheus-stack",
        version: "61.3.2",
        repository: "prometheus-community",
        deployed: 40 * DAY,
        status: "failed",
        conditions: [
          cond("Stalled", "True", "RetriesExceeded", "Failed to upgrade after 3 attempt(s)", 3 * HOUR),
          cond(
            "Ready",
            "False",
            "UpgradeFailed",
            "Helm upgrade failed for release monitoring/kube-prometheus-stack with chart kube-prometheus-stack@61.3.2: cannot patch \"kube-prometheus-stack-grafana\" with kind Deployment: Deployment.apps \"kube-prometheus-stack-grafana\" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{\"app.kubernetes.io/instance\":\"kube-prometheus-stack\", \"app.kubernetes.io/name\":\"grafana\"}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable",
            3 * HOUR
          ),
          cond("Released", "False", "UpgradeFailed", "Helm upgrade failed: field is immutable", 3 * HOUR),
        ],
      }),
    ],
  };
}

function fluxStaging() {
  const revision = `main@sha1:${sha("fleet-staging")}`;
  return {
    gitrepositories: [gitRepository("fleet", "https://github.com/acme/fleet.git", "main", { since: 25 * MIN })],
    helmrepositories: [helmRepository("podinfo", "oci://ghcr.io/stefanprodan/charts", true)],
    ocirepositories: [],
    helmcharts: [],
    kustomizations: [
      kustomization({ name: "flux-system", path: "./clusters/staging", conditions: ready(`Applied revision: ${revision}`, 25 * MIN), revision }),
      kustomization({ name: "infra-controllers", path: "./infrastructure/controllers", conditions: ready(`Applied revision: ${revision}`, 25 * MIN), revision }),
      kustomization({
        name: "payments",
        path: "./apps/payments/staging",
        targetNamespace: "payments",
        conditions: ready(`Applied revision: ${revision}`, 25 * MIN),
        revision,
        entries: [
          { ns: "payments", name: "payments-api", group: "apps", kind: "Deployment" },
          { ns: "payments", name: "payments-api", kind: "Service" },
        ],
      }),
      kustomization({ name: "checkout", path: "./apps/checkout/staging", targetNamespace: "checkout", conditions: ready(`Applied revision: ${revision}`, 25 * MIN), revision }),
    ],
    helmreleases: [
      {
        ...helmRelease({
          name: "podinfo",
          namespace: "default",
          chart: "podinfo",
          version: "6.7.1",
          repository: "podinfo",
          deployed: 5 * DAY,
          conditions: ready("Helm install succeeded for release default/podinfo.v1 with chart podinfo@6.7.1", 5 * DAY),
        }),
      },
    ],
  };
}

/* --------------------------------------------------------- Argo CD -- */

const ARGO = "argocd";
const argoMeta = (name: string, extra: Record<string, unknown> = {}) => ({
  ...meta(name, ARGO),
  labels: {},
  finalizers: ["resources-finalizer.argocd.argoproj.io"],
  ...extra,
});

interface ArgoResource {
  kind: string;
  name: string;
  group?: string;
  namespace?: string;
  status?: string;
  health?: string;
  message?: string;
  requiresPruning?: boolean;
}

interface AppSpec {
  name: string;
  namespace: string;
  repo?: string;
  path?: string;
  chart?: { repo: string; name: string; version: string };
  sync: string;
  health: string;
  revision: string;
  automated?: { prune?: boolean; selfHeal?: boolean };
  resources: ArgoResource[];
  operation?: any;
  lastSync: number;
  owner?: any;
  destination?: { name?: string; server?: string };
  conditions?: any[];
}

const application = (a: AppSpec) => {
  const revision = a.chart ? a.chart.version : sha(a.revision);
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: argoMeta(a.name, a.owner ? { ownerReferences: [a.owner] } : {}),
    spec: {
      project: a.chart ? "platform" : "default",
      source: a.chart
        ? { repoURL: a.chart.repo, chart: a.chart.name, targetRevision: a.chart.version }
        : { repoURL: a.repo, path: a.path, targetRevision: "main" },
      destination: { ...(a.destination ?? { server: "https://kubernetes.default.svc" }), namespace: a.namespace },
      syncPolicy: { ...(a.automated ? { automated: a.automated } : {}), syncOptions: ["CreateNamespace=true"] },
    },
    status: {
      sync: { status: a.sync, revision, comparedTo: { source: {} } },
      health: { status: a.health, lastTransitionTime: ago(a.lastSync) },
      reconciledAt: ago(2 * MIN),
      sourceType: a.chart ? "Helm" : "Kustomize",
      resources: a.resources.map((r) => ({
        group: r.group ?? (["Deployment", "StatefulSet"].includes(r.kind) ? "apps" : r.kind === "Ingress" ? "networking.k8s.io" : ""),
        version: "v1",
        kind: r.kind,
        namespace: r.namespace ?? a.namespace,
        name: r.name,
        status: r.status ?? "Synced",
        ...(r.health ? { health: { status: r.health, ...(r.message ? { message: r.message } : {}) } } : {}),
        ...(r.requiresPruning ? { requiresPruning: true } : {}),
      })),
      history: [{ id: 7, revision, deployedAt: ago(a.lastSync), deployStartedAt: ago(a.lastSync + 40), source: {} }],
      operationState: a.operation ?? {
        operation: { sync: { revision }, initiatedBy: { automated: !!a.automated } },
        phase: "Succeeded",
        message: "successfully synced (all tasks run)",
        startedAt: ago(a.lastSync + 40),
        finishedAt: ago(a.lastSync),
        syncResult: { revision },
      },
      ...(a.conditions ? { conditions: a.conditions } : {}),
    },
  };
};

function argoProd() {
  const appSet = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "ApplicationSet",
    metadata: argoMeta("guestbook"),
    spec: {
      goTemplate: true,
      generators: [{ list: { elements: [{ cluster: "prod", url: "https://kubernetes.default.svc" }, { cluster: "staging", url: "https://staging.k8s.example.com:6443" }] } }],
      template: {
        metadata: { name: "guestbook-{{.cluster}}" },
        spec: {
          project: "default",
          source: { repoURL: "https://github.com/acme/gitops-apps.git", targetRevision: "main", path: "apps/guestbook/{{.cluster}}" },
          destination: { server: "{{.url}}", namespace: "guestbook" },
        },
      },
    },
    status: { conditions: [{ type: "ResourcesUpToDate", status: "True", reason: "ApplicationSetUpToDate", message: "All applications have been generated successfully", lastTransitionTime: ago(6 * DAY) }] },
  };
  const owner = { apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", name: "guestbook", uid: appSet.metadata.uid, controller: true, blockOwnerDeletion: true };
  const repo = "https://github.com/acme/gitops-apps.git";
  return {
    applicationsets: [appSet],
    appprojects: [
      { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: argoMeta("default"), spec: { sourceRepos: ["*"], destinations: [{ namespace: "*", server: "*" }] } },
      { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: argoMeta("platform"), spec: { description: "Shared platform components", sourceRepos: ["https://argoproj.github.io/argo-helm"], destinations: [{ namespace: "argo-rollouts", server: "https://kubernetes.default.svc" }] } },
    ],
    applications: [
      application({
        name: "checkout-web",
        namespace: "checkout",
        repo,
        path: "apps/checkout-web/overlays/prod",
        sync: "OutOfSync",
        health: "Healthy",
        revision: "checkout-web",
        lastSync: 3 * DAY,
        resources: [
          { kind: "Deployment", name: "checkout-web", status: "OutOfSync", health: "Healthy" },
          { kind: "ConfigMap", name: "checkout-flags", status: "OutOfSync" },
          { kind: "Service", name: "checkout-web", health: "Healthy" },
          { kind: "Ingress", name: "checkout", health: "Healthy" },
          { kind: "ConfigMap", name: "checkout-web-legacy", status: "OutOfSync", requiresPruning: true },
        ],
      }),
      application({
        name: "checkout-api",
        namespace: "checkout",
        repo,
        path: "apps/checkout-api/overlays/prod",
        sync: "OutOfSync",
        health: "Progressing",
        revision: "checkout-api",
        automated: { prune: true, selfHeal: true },
        lastSync: 3 * DAY,
        resources: [
          { kind: "Deployment", name: "checkout-api", status: "OutOfSync", health: "Progressing", message: "Waiting for rollout to finish: 1 of 3 updated replicas are available..." },
          { kind: "Service", name: "checkout-api", health: "Healthy" },
          { kind: "PodDisruptionBudget", group: "policy", name: "checkout-api", health: "Healthy" },
        ],
        operation: {
          operation: { sync: { revision: sha("checkout-api") }, initiatedBy: { automated: true } },
          phase: "Running",
          message: "waiting for healthy state of apps/Deployment/checkout-api",
          startedAt: ago(70),
        },
      }),
      application({
        name: "image-resizer",
        namespace: "checkout",
        repo,
        path: "apps/image-resizer/overlays/prod",
        sync: "Synced",
        health: "Degraded",
        revision: "image-resizer",
        automated: { selfHeal: true },
        lastSync: 25 * MIN,
        resources: [
          { kind: "Deployment", name: "image-resizer", health: "Degraded", message: 'Deployment "image-resizer" exceeded its progress deadline' },
          { kind: "Service", name: "image-resizer", health: "Healthy" },
        ],
      }),
      application({
        name: "cart-service",
        namespace: "checkout",
        repo,
        path: "apps/cart-service/overlays/prod",
        sync: "Synced",
        health: "Healthy",
        revision: "cart-service",
        automated: { prune: true, selfHeal: true },
        lastSync: 6 * DAY,
        resources: [
          { kind: "Deployment", name: "cart-service", health: "Healthy" },
          { kind: "Service", name: "cart-service", health: "Healthy" },
          { kind: "StatefulSet", name: "redis", health: "Healthy" },
          { kind: "Service", name: "redis", health: "Healthy" },
        ],
      }),
      application({
        name: "guestbook-prod",
        namespace: "guestbook",
        repo,
        path: "apps/guestbook/prod",
        sync: "Synced",
        health: "Healthy",
        revision: "guestbook",
        owner,
        lastSync: 6 * DAY,
        resources: [
          { kind: "Deployment", name: "guestbook-ui", health: "Healthy" },
          { kind: "Service", name: "guestbook-ui", health: "Healthy" },
        ],
      }),
      application({
        name: "guestbook-staging",
        namespace: "guestbook",
        repo,
        path: "apps/guestbook/staging",
        sync: "Synced",
        health: "Healthy",
        revision: "guestbook",
        owner,
        destination: { server: "https://staging.k8s.example.com:6443" },
        lastSync: 6 * DAY,
        resources: [
          { kind: "Deployment", name: "guestbook-ui", health: "Healthy" },
          { kind: "Service", name: "guestbook-ui", health: "Healthy" },
        ],
      }),
      application({
        name: "argo-rollouts",
        namespace: "argo-rollouts",
        chart: { repo: "https://argoproj.github.io/argo-helm", name: "argo-rollouts", version: "2.37.7" },
        sync: "Synced",
        health: "Healthy",
        revision: "argo-rollouts",
        automated: { prune: true, selfHeal: true },
        lastSync: 12 * DAY,
        resources: [
          { kind: "Deployment", name: "argo-rollouts", health: "Healthy" },
          { kind: "ServiceAccount", name: "argo-rollouts" },
          { kind: "ClusterRole", group: "rbac.authorization.k8s.io", namespace: "", name: "argo-rollouts" },
          { kind: "CustomResourceDefinition", group: "apiextensions.k8s.io", namespace: "", name: "rollouts.argoproj.io" },
        ],
      }),
    ],
  };
}

/* ---------------------------------------------------------- install -- */

/* The Flux and Argo CD API groups (in API_GROUPS, fixtures.ts). */
const GITOPS_GROUP_NAMES = new Set(API_GROUPS.map((g) => g.name).filter((name) => name.endsWith("fluxcd.io") || name === "argoproj.io"));

const add = (context: string, lists: Record<string, any[]>) => {
  const cluster = CLUSTERS[context]!;
  for (const [key, items] of Object.entries(lists)) cluster[key] = [...(cluster[key] ?? []), ...items];
};
add(CONTEXTS[0]!.name, { ...fluxProd(), ...argoProd() });
add(CONTEXTS[1]!.name, fluxStaging());

type Emit = (key: string, change: { added?: any[]; modified?: any[]; deleted?: any[] }, context: string) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* RFC 7386 merge patch: objects merge, null removes, everything else replaces. */
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

let resourceVersion = 50_000;

export function createGitopsMocks(scenario: string, emit: Emit) {
  const listOf = (context: string, plural: string): any[] => (CLUSTERS[context]?.[plural] ?? []) as any[];
  const find = (context: string, plural: string, namespace: string, name: string) =>
    listOf(context, plural).find((o) => o.metadata?.name === name && (o.metadata?.namespace ?? "") === namespace);

  /* Replaces the object and tells its watchers. */
  const update = (context: string, plural: string, object: any, change: (o: any) => any) => {
    const list = listOf(context, plural);
    const index = list.findIndex((o) => o.metadata?.uid === object.metadata?.uid);
    if (index < 0) return null;
    const next = change(structuredClone(list[index]));
    next.metadata = { ...next.metadata, resourceVersion: String(++resourceVersion) };
    list[index] = next;
    emit(plural, { modified: [next] }, context);
    return next;
  };

  /* Flux: "Reconciling" for a moment, then the same outcome as before (fresh times). */
  const playReconcile = async (context: string, plural: string, object: any, token: string) => {
    const outcome = structuredClone(object.status?.conditions ?? []);
    await sleep(350);
    update(context, plural, object, (o) => ({
      ...o,
      status: {
        ...o.status,
        conditions: [
          { type: "Reconciling", status: "True", reason: "Progressing", message: "Reconciliation in progress", lastTransitionTime: new Date().toISOString() },
          { type: "Ready", status: "Unknown", reason: "Progressing", message: "Reconciliation in progress", lastTransitionTime: new Date().toISOString() },
        ],
      },
    }));
    await sleep(1800);
    update(context, plural, object, (o) => ({
      ...o,
      status: {
        ...o.status,
        lastHandledReconcileAt: token,
        conditions: outcome.map((c: any) => ({ ...c, lastTransitionTime: new Date().toISOString() })),
        ...(o.status?.artifact ? { artifact: { ...o.status.artifact, lastUpdateTime: new Date().toISOString() } } : {}),
      },
    }));
  };

  /* Argo CD: the operation runs, then succeeds (health stays what it is). */
  const playSync = async (context: string, object: any, operation: any) => {
    await sleep(400);
    const startedAt = new Date().toISOString();
    update(context, "applications", object, (o) => {
      delete o.operation;
      o.status.operationState = { operation, phase: "Running", message: "one or more tasks are running", startedAt };
      return o;
    });
    await sleep(2200);
    update(context, "applications", object, (o) => {
      const resources = (o.status.resources ?? [])
        .filter((r: any) => !(operation.sync?.prune && r.requiresPruning))
        .map((r: any) => ({ ...r, status: r.requiresPruning ? "OutOfSync" : "Synced" }));
      const pruneLeft = resources.some((r: any) => r.requiresPruning);
      const finishedAt = new Date().toISOString();
      o.status = {
        ...o.status,
        resources,
        sync: { ...o.status.sync, status: pruneLeft ? "OutOfSync" : "Synced" },
        health: o.status.health?.status === "Progressing" ? { status: "Healthy", lastTransitionTime: finishedAt } : o.status.health,
        operationState: { operation, phase: "Succeeded", message: "successfully synced (all tasks run)", startedAt, finishedAt, syncResult: { revision: o.status.sync?.revision } },
        history: [...(o.status.history ?? []), { id: (o.status.history?.length ?? 0) + 8, revision: o.status.sync?.revision, deployedAt: finishedAt, deployStartedAt: startedAt }],
      };
      return o;
    });
  };

  const playRefresh = async (context: string, object: any) => {
    await sleep(900);
    update(context, "applications", object, (o) => {
      delete o.metadata.annotations?.["argocd.argoproj.io/refresh"];
      o.status.reconciledAt = new Date().toISOString();
      return o;
    });
  };

  registerKubeRoutes([
    {
      method: "PATCH",
      path: /^\/apis\/([a-z.]*(?:fluxcd|argoproj)\.io)\/[^/]+\/namespaces\/([^/]+)\/([^/]+)\/([^/]+)$/,
      handle: (request, match) => {
        const [, , namespace, plural, name] = match;
        const object = find(request.context, plural!, decodeURIComponent(namespace!), decodeURIComponent(name!));
        if (!object) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        const before = structuredClone(object);
        const patched = update(request.context, plural!, object, (o) => mergePatch(o, request.body));
        const token = request.body?.metadata?.annotations?.["reconcile.fluxcd.io/requestedAt"];
        if (token && before.metadata?.annotations?.["reconcile.fluxcd.io/requestedAt"] !== token && !patched.spec?.suspend) {
          void playReconcile(request.context, plural!, patched, token);
        }
        if (request.body?.operation) void playSync(request.context, patched, request.body.operation);
        if (request.body?.metadata?.annotations?.["argocd.argoproj.io/refresh"]) void playRefresh(request.context, patched);
        return patched;
      },
    },
    {
      // One object (opening a delivered resource looks up its uid).
      method: "GET",
      path: /^\/(?:api\/v1|apis\/[^/]+\/[^/]+)\/(?:namespaces\/([^/]+)\/)?([a-z0-9]+)\/([^/]+)$/,
      handle: (request, match) => {
        const [, namespace, plural, name] = match;
        if (plural === "namespaces" && !namespace) {
          const found = listOf(request.context, "namespaces").find((n) => n.metadata?.name === name);
          if (found) return found;
        }
        const object = listOf(request.context, plural!).find(
          (o) => o.metadata?.name === decodeURIComponent(name!) && (!namespace || o.metadata?.namespace === decodeURIComponent(namespace))
        );
        if (!object) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        return object;
      },
    },
  ]);

  /* ?scenario=no-gitops: discovery without the Flux and Argo CD groups. */
  const handlers: Record<string, (payload: any) => unknown> =
    scenario === "no-gitops"
      ? {
          get_api_groups: () =>
            API_GROUPS.filter((g) => !GITOPS_GROUP_NAMES.has(g.name)).map((g) => ({
              name: g.name,
              versions: [{ groupVersion: g.version, version: g.version.split("/")[1] }],
              preferredVersion: { groupVersion: g.version, version: g.version.split("/")[1] },
            })),
        }
      : {};

  return { handlers };
}
