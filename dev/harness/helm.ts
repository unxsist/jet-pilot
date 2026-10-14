/*
 * Helm (src-tauri/src/helm): native release reads, chart packages, Artifact
 * Hub, plus the helm CLI calls the Helm screens make (repositories, search,
 * install). Releases and repositories live in sessionStorage so installs,
 * repository changes and reloads stick.
 *
 * ?scenario=helm-norepos   no repositories configured yet
 * ?scenario=empty          no releases
 */
type Values = Record<string, any>;

interface ReleaseDef {
  context: string;
  name: string;
  namespace: string;
  chart: string;
  repo: string;
  description: string;
  home?: string;
  sources?: string[];
  /** Revision → { status, chartVersion, appVersion, values, description, hoursAgo } */
  revisions: RevisionDef[];
  manifest: (values: Values, revision: number) => string;
  notes?: (release: ReleaseDef) => string;
  hooks?: { name: string; kind: string; events: string[]; phase: string; weight: number }[];
}

interface RevisionDef {
  revision: number;
  status: string;
  chartVersion: string;
  appVersion: string;
  values: Values;
  description: string;
  hoursAgo: number;
}

const HOUR = 3600 * 1000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

/* ------------------------------------------------------------ manifests -- */

const doc = (source: string, body: string) => `---\n# Source: ${source}\n${body.trim()}\n`;
const meta = (kind: string, apiVersion: string, name: string, extra = "") =>
  `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: ${name}\n  labels:\n    app.kubernetes.io/managed-by: Helm\n${extra}`;

const deployment = (chart: string, name: string, image: string, replicas: number) =>
  doc(
    `${chart}/templates/deployment.yaml`,
    `${meta("Deployment", "apps/v1", name)}spec:\n  replicas: ${replicas}\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: ${name}\n  template:\n    spec:\n      containers:\n        - name: ${name}\n          image: ${image}\n`
  );
const service = (chart: string, name: string, port = 80) =>
  doc(`${chart}/templates/service.yaml`, `${meta("Service", "v1", name)}spec:\n  ports:\n    - port: ${port}\n      targetPort: http\n`);
const simple = (chart: string, kind: string, apiVersion: string, name: string, file: string) =>
  doc(`${chart}/templates/${file}`, meta(kind, apiVersion, name));

const paymentsManifest = (v: Values) =>
  [
    simple("payments-api", "ServiceAccount", "v1", "payments-api", "serviceaccount.yaml"),
    simple("payments-api", "ConfigMap", "v1", "payments-api-config", "configmap.yaml"),
    simple("payments-api", "Secret", "v1", "payments-api-env", "secret.yaml"),
    service("payments-api", "payments-api"),
    deployment("payments-api", "payments-api", `ghcr.io/acme/payments-api:${v.image?.tag ?? "v2.14.3"}`, v.replicaCount ?? 4),
    deployment("payments-api", "payments-worker", `ghcr.io/acme/payments-worker:${v.image?.tag ?? "v2.14.3"}`, 3),
    simple("payments-api", "HorizontalPodAutoscaler", "autoscaling/v2", "payments-api", "hpa.yaml"),
    ...(v.podDisruptionBudget ? [simple("payments-api", "PodDisruptionBudget", "policy/v1", "payments-api", "pdb.yaml")] : []),
    simple("payments-api", "Ingress", "networking.k8s.io/v1", "payments-api", "ingress.yaml"),
    simple("payments-api", "ServiceMonitor", "monitoring.coreos.com/v1", "payments-api", "servicemonitor.yaml"),
  ].join("");

const checkoutManifest = (v: Values) =>
  [
    deployment("checkout", "checkout-api", `ghcr.io/acme/checkout-api:v${v.version ?? "3.2.0"}`, 3),
    deployment("checkout", "checkout-web", `ghcr.io/acme/checkout-web:v${v.version ?? "3.2.0"}`, 3),
    deployment("checkout", "cart-service", "ghcr.io/acme/cart:v1.4.2", 2),
    deployment("checkout", "image-resizer", "ghcr.io/acme/image-resizer:v0.9.1-rc", 2),
    service("checkout", "checkout-api"),
    service("checkout", "checkout-web"),
    service("checkout", "cart-service"),
    service("checkout", "image-resizer"),
    simple("checkout", "Ingress", "networking.k8s.io/v1", "checkout", "ingress.yaml"),
    simple("checkout", "ConfigMap", "v1", "checkout-flags", "configmap.yaml"),
  ].join("");

const promManifest = () =>
  [
    ...["prometheus", "grafana", "alertmanager"].map((n) => deployment("kube-prometheus-stack", n, `example/${n}:latest`, 1)),
    ...["prometheus", "grafana", "alertmanager", "kube-state-metrics", "node-exporter"].map((n) => service("kube-prometheus-stack", n, 9090)),
    doc("kube-prometheus-stack/charts/prometheus-node-exporter/templates/daemonset.yaml", `${meta("DaemonSet", "apps/v1", "node-exporter")}spec: {}\n`),
    ...["grafana-dashboards-k8s", "grafana-dashboards-nodes", "grafana-datasources", "prometheus-rules-config"].map((n) =>
      simple("kube-prometheus-stack", "ConfigMap", "v1", n, "configmaps.yaml")
    ),
    simple("kube-prometheus-stack", "Secret", "v1", "grafana-admin", "grafana/secret.yaml"),
    ...["prometheus", "grafana", "alertmanager", "kube-state-metrics"].map((n) =>
      simple("kube-prometheus-stack", "ServiceAccount", "v1", n, "serviceaccounts.yaml")
    ),
    ...["kube-prometheus-stack-operator", "kube-state-metrics"].map((n) =>
      simple("kube-prometheus-stack", "ClusterRole", "rbac.authorization.k8s.io/v1", n, "rbac.yaml")
    ),
    ...["kube-prometheus-stack-operator", "kube-state-metrics"].map((n) =>
      simple("kube-prometheus-stack", "ClusterRoleBinding", "rbac.authorization.k8s.io/v1", n, "rbac.yaml")
    ),
    ...["kubernetes-apps", "kubernetes-resources", "node-exporter", "alertmanager"].map((n) =>
      simple("kube-prometheus-stack", "PrometheusRule", "monitoring.coreos.com/v1", n, "rules.yaml")
    ),
    ...["apiserver", "kubelet", "coredns", "node-exporter", "grafana"].map((n) =>
      simple("kube-prometheus-stack", "ServiceMonitor", "monitoring.coreos.com/v1", n, "servicemonitors.yaml")
    ),
    simple("kube-prometheus-stack", "Prometheus", "monitoring.coreos.com/v1", "kube-prometheus-stack", "prometheus.yaml"),
    simple("kube-prometheus-stack", "Alertmanager", "monitoring.coreos.com/v1", "kube-prometheus-stack", "alertmanager.yaml"),
    simple("kube-prometheus-stack", "MutatingWebhookConfiguration", "admissionregistration.k8s.io/v1", "kube-prometheus-stack-admission", "webhook.yaml"),
  ].join("");

const ingressManifest = () =>
  [
    deployment("ingress-nginx", "ingress-nginx-controller", "registry.k8s.io/ingress-nginx/controller:v1.11.1", 2),
    service("ingress-nginx", "ingress-nginx-controller", 443),
    simple("ingress-nginx", "IngressClass", "networking.k8s.io/v1", "nginx", "ingressclass.yaml"),
    simple("ingress-nginx", "ConfigMap", "v1", "ingress-nginx-controller", "configmap.yaml"),
    simple("ingress-nginx", "ServiceAccount", "v1", "ingress-nginx", "serviceaccount.yaml"),
    simple("ingress-nginx", "ClusterRole", "rbac.authorization.k8s.io/v1", "ingress-nginx", "clusterrole.yaml"),
    simple("ingress-nginx", "ValidatingWebhookConfiguration", "admissionregistration.k8s.io/v1", "ingress-nginx-admission", "webhook.yaml"),
  ].join("");

const certManagerManifest = () =>
  [
    deployment("cert-manager", "cert-manager", "quay.io/jetstack/cert-manager-controller:v1.15.1", 1),
    deployment("cert-manager", "cert-manager-webhook", "quay.io/jetstack/cert-manager-webhook:v1.15.1", 1),
    service("cert-manager", "cert-manager-webhook", 443),
    ...["certificates.cert-manager.io", "issuers.cert-manager.io", "clusterissuers.cert-manager.io"].map((n) =>
      simple("cert-manager", "CustomResourceDefinition", "apiextensions.k8s.io/v1", n, "crds.yaml")
    ),
    simple("cert-manager", "ServiceAccount", "v1", "cert-manager", "serviceaccount.yaml"),
  ].join("");

const flagsManifest = (v: Values) =>
  [
    deployment("feature-flags", "feature-flags", `ghcr.io/acme/feature-flags:v${v.image?.tag ?? "0.22.0"}`, 2),
    service("feature-flags", "feature-flags"),
    simple("feature-flags", "ConfigMap", "v1", "feature-flags-rules", "configmap.yaml"),
  ].join("");

/* ------------------------------------------------------------- releases -- */

const paymentsValues = (revision: number): Values => ({
  image: { repository: "ghcr.io/acme/payments-api", tag: `v2.14.${revision >= 42 ? 3 : 2}` },
  replicaCount: revision >= 41 ? 4 : 3,
  resources: { requests: { cpu: "250m", memory: "256Mi" } },
  ingress: { enabled: true, host: "payments.acme.internal" },
  ...(revision >= 40 ? { podDisruptionBudget: { minAvailable: 2 } } : {}),
  ...(revision === 40 ? { featureFlags: { fastRefunds: true } } : {}),
});

const RELEASES: ReleaseDef[] = [
  {
    context: "prod-eu-west-1",
    name: "payments-api",
    namespace: "payments",
    chart: "payments-api",
    repo: "acme",
    description: "Payments API for the Acme storefront",
    home: "https://github.com/acme/payments-api",
    sources: ["https://github.com/acme/charts/tree/main/payments-api"],
    revisions: [38, 39, 40, 41, 42].map((revision) => ({
      revision,
      status: revision === 42 ? "deployed" : revision === 40 ? "failed" : "superseded",
      chartVersion: `2.14.${revision >= 42 ? 3 : 2}`,
      appVersion: `2.14.${revision >= 42 ? 3 : 2}`,
      values: paymentsValues(revision),
      description:
        revision === 40
          ? 'Upgrade "payments-api" failed: context deadline exceeded'
          : revision === 38
            ? "Install complete"
            : revision === 41
              ? "Rollback to 39"
              : "Upgrade complete",
      hoursAgo: revision === 42 ? 2 : (43 - revision) * 41,
    })),
    manifest: paymentsManifest,
    notes: (r) =>
      [
        "Payments API is running.",
        "",
        "1. Get the application URL by running these commands:",
        `  export POD_NAME=$(kubectl get pods --namespace ${r.namespace} -l "app.kubernetes.io/name=payments-api" -o jsonpath="{.items[0].metadata.name}")`,
        `  kubectl --namespace ${r.namespace} port-forward $POD_NAME 8080:8080`,
        "",
        "2. Open http://127.0.0.1:8080/healthz to check it is up.",
        "",
        "Refunds are processed by payments-worker; scale it with the worker.replicaCount value.",
      ].join("\n"),
    hooks: [
      { name: "payments-api-migrate", kind: "Job", events: ["pre-install", "pre-upgrade"], phase: "Succeeded", weight: -5 },
      { name: "payments-api-test-connection", kind: "Pod", events: ["test"], phase: "", weight: 0 },
    ],
  },
  {
    context: "prod-eu-west-1",
    name: "checkout",
    namespace: "checkout",
    chart: "checkout",
    repo: "acme",
    description: "Checkout services: API, web front end, cart and image resizing",
    revisions: [15, 16, 17].map((revision) => ({
      revision,
      status: revision === 17 ? "failed" : revision === 16 ? "deployed" : "superseded",
      chartVersion: revision === 17 ? "3.2.0" : "3.1.4",
      appVersion: revision === 17 ? "3.2.0" : "3.1.4",
      values: { version: revision === 17 ? "3.2.0" : "3.1.4", imageResizer: { enabled: revision === 17 }, replicaCount: 3 },
      description:
        revision === 17
          ? 'Upgrade "checkout" failed: timed out waiting for the condition: deployment "image-resizer" exceeded its progress deadline'
          : revision === 15
            ? "Install complete"
            : "Upgrade complete",
      hoursAgo: revision === 17 ? 72 : (18 - revision) * 200,
    })),
    manifest: checkoutManifest,
    notes: () => "Checkout is available at https://checkout.acme.dev\n\nRun the smoke tests with:\n  helm test checkout --namespace checkout",
  },
  {
    context: "prod-eu-west-1",
    name: "kube-prometheus-stack",
    namespace: "monitoring",
    chart: "kube-prometheus-stack",
    repo: "prometheus-community",
    description: "kube-prometheus-stack collects Kubernetes manifests, Grafana dashboards, and Prometheus rules combined with documentation and scripts to provide easy to operate end-to-end Kubernetes cluster monitoring with Prometheus using the Prometheus Operator.",
    home: "https://github.com/prometheus-operator/kube-prometheus",
    sources: ["https://github.com/prometheus-community/helm-charts"],
    revisions: [8, 9].map((revision) => ({
      revision,
      status: revision === 9 ? "deployed" : "superseded",
      chartVersion: revision === 9 ? "61.3.2" : "60.0.1",
      appVersion: revision === 9 ? "v0.75.2" : "v0.74.0",
      values: { grafana: { adminPassword: "change-me", persistence: { enabled: true, size: "10Gi" } }, prometheus: { prometheusSpec: { retention: revision === 9 ? "15d" : "10d" } } },
      description: revision === 8 ? "Install complete" : "Upgrade complete",
      hoursAgo: revision === 9 ? 40 * 24 : 90 * 24,
    })),
    manifest: promManifest,
    notes: (r) =>
      `kube-prometheus-stack has been installed. Check its status by running:\n  kubectl --namespace ${r.namespace} get pods -l "release=${r.name}"\n\nGet Grafana 'admin' user password by running:\n\n  kubectl --namespace ${r.namespace} get secrets grafana-admin -o jsonpath="{.data.admin-password}" | base64 -d ; echo\n\nVisit https://github.com/prometheus-operator/kube-prometheus for instructions on how to create & configure Alertmanager and Prometheus instances using the Operator.`,
  },
  {
    context: "prod-eu-west-1",
    name: "ingress-nginx",
    namespace: "ingress-nginx",
    chart: "ingress-nginx",
    repo: "ingress-nginx",
    description: "Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer",
    home: "https://github.com/kubernetes/ingress-nginx",
    revisions: [6].map((revision) => ({ revision, status: "deployed", chartVersion: "4.11.1", appVersion: "1.11.1", values: { controller: { replicaCount: 2, service: { type: "LoadBalancer" } } }, description: "Upgrade complete", hoursAgo: 88 * 24 })),
    manifest: ingressManifest,
    notes: () =>
      "The ingress-nginx controller has been installed.\nIt may take a few minutes for the load balancer IP to be available.\nYou can watch the status by running 'kubectl get service --namespace ingress-nginx ingress-nginx-controller --output wide --watch'",
  },
  {
    context: "prod-eu-west-1",
    name: "cert-manager",
    namespace: "cert-manager",
    chart: "cert-manager",
    repo: "jetstack",
    description: "A Helm chart for cert-manager",
    home: "https://cert-manager.io",
    sources: ["https://github.com/cert-manager/cert-manager"],
    revisions: [3].map((revision) => ({ revision, status: "deployed", chartVersion: "v1.15.1", appVersion: "v1.15.1", values: { crds: { enabled: true } }, description: "Upgrade complete", hoursAgo: 120 * 24 })),
    manifest: certManagerManifest,
    notes: () => "cert-manager v1.15.1 has been deployed successfully!\n\nIn order to begin issuing certificates, you will need to set up a ClusterIssuer\nor Issuer resource (for example, by creating a 'letsencrypt-staging' issuer).",
  },
  {
    context: "prod-eu-west-1",
    name: "feature-flags",
    namespace: "platform",
    chart: "feature-flags",
    repo: "acme",
    description: "Feature flag service",
    revisions: [1, 2].map((revision) => ({ revision, status: revision === 2 ? "pending-upgrade" : "superseded", chartVersion: revision === 2 ? "0.22.0" : "0.21.3", appVersion: revision === 2 ? "0.22.0" : "0.21.3", values: { image: { tag: revision === 2 ? "0.22.0" : "0.21.3" }, rules: { refresh: "30s" } }, description: revision === 2 ? "Preparing upgrade" : "Install complete", hoursAgo: revision === 2 ? 0.15 : 9 })),
    manifest: flagsManifest,
  },
  {
    context: "staging-us-east-2",
    name: "payments-api",
    namespace: "payments",
    chart: "payments-api",
    repo: "acme",
    description: "Payments API for the Acme storefront",
    revisions: [11, 12].map((revision) => ({ revision, status: revision === 12 ? "deployed" : "superseded", chartVersion: "2.15.0", appVersion: "2.15.0", values: paymentsValues(43), description: "Upgrade complete", hoursAgo: revision === 12 ? 5 : 30 })),
    manifest: paymentsManifest,
  },
];

const RELEASE_STORE = "harness-helm-installed";
const installed = (): ReleaseDef[] =>
  (JSON.parse(sessionStorage.getItem(RELEASE_STORE) || "[]") as any[]).map((r) => ({
    ...r,
    manifest: () => r.manifestText,
    notes: () => r.notesText,
  }));

/* ---------------------------------------------------------------- charts -- */

interface CatalogChart {
  repo: string;
  repoUrl: string;
  repoDisplay: string;
  name: string;
  description: string;
  versions: { version: string; appVersion: string; daysAgo: number; prerelease?: boolean }[];
  official?: boolean;
  verified?: boolean;
  cncf?: boolean;
  logo?: string;
  stars: number;
  home: string;
  values: string;
  schema?: Values;
  objects: [string, string][];
  notes: string;
}

const svgLogo = (fill: string, path: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${fill}"/>${path}</svg>`)}`;

const CATALOG: CatalogChart[] = [
  {
    repo: "bitnami",
    repoUrl: "https://charts.bitnami.com/bitnami",
    repoDisplay: "Bitnami",
    name: "redis",
    description: "Redis(R) is an open source, advanced key-value store. It is often referred to as a data structure server since keys can contain strings, hashes, lists, sets and sorted sets.",
    versions: [
      { version: "19.6.4", appVersion: "7.2.5", daysAgo: 12 },
      { version: "19.6.3", appVersion: "7.2.5", daysAgo: 30 },
      { version: "20.0.0-rc.1", appVersion: "7.4.0", daysAgo: 4, prerelease: true },
      { version: "19.5.5", appVersion: "7.2.5", daysAgo: 61 },
      { version: "18.19.4", appVersion: "7.2.4", daysAgo: 140 },
    ],
    verified: true,
    logo: "e3f8a3f6-1d55-4a3f-8a52-3c1a9c1e0b11",
    stars: 512,
    home: "https://bitnami.com",
    values: `## @section Global parameters
global:
  ## @param global.imageRegistry Global Docker image registry
  imageRegistry: ""

## @param architecture Redis(R) architecture. Allowed values: \`standalone\` or \`replication\`
architecture: replication

auth:
  ## @param auth.enabled Enable password authentication
  enabled: true
  ## @param auth.password Redis(R) password (a random one when empty)
  password: ""

master:
  ## @param master.count Number of Redis(R) master instances to deploy
  count: 1
  persistence:
    ## @param master.persistence.enabled Enable persistence on Redis(R) master nodes
    enabled: true
    size: 8Gi

replica:
  ## @param replica.replicaCount Number of Redis(R) replicas to deploy
  replicaCount: 3
  persistence:
    enabled: true
    size: 8Gi

metrics:
  ## @param metrics.enabled Start a sidecar prometheus exporter to expose Redis(R) metrics
  enabled: false
`,
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        architecture: { type: "string", enum: ["standalone", "replication"], description: "Redis(R) architecture" },
        auth: { type: "object", properties: { enabled: { type: "boolean" }, password: { type: "string" } } },
        replica: { type: "object", properties: { replicaCount: { type: "integer", minimum: 0, description: "Number of Redis(R) replicas to deploy" } } },
      },
    },
    objects: [
      ["StatefulSet", "redis-master"],
      ["StatefulSet", "redis-replicas"],
      ["Service", "redis-headless"],
      ["Service", "redis-master"],
      ["Service", "redis-replicas"],
      ["ConfigMap", "redis-configuration"],
      ["ConfigMap", "redis-health"],
      ["ConfigMap", "redis-scripts"],
      ["Secret", "redis"],
      ["ServiceAccount", "redis-master"],
      ["NetworkPolicy", "redis"],
      ["PodDisruptionBudget", "redis-master"],
      ["PodDisruptionBudget", "redis-replicas"],
    ],
    notes: `CHART NAME: redis
CHART VERSION: 19.6.4
APP VERSION: 7.2.5

** Please be patient while the chart is being deployed **

Redis® can be accessed on the following DNS names from within your cluster:

    {{release}}-redis-master.{{namespace}}.svc.cluster.local for read/write operations (port 6379)
    {{release}}-redis-replicas.{{namespace}}.svc.cluster.local for read-only operations (port 6379)

To get your password run:

    export REDIS_PASSWORD=$(kubectl get secret --namespace {{namespace}} {{release}}-redis -o jsonpath="{.data.redis-password}" | base64 -d)

To connect to your Redis® server, run a client pod:

    kubectl run --namespace {{namespace}} redis-client --restart='Never' --env REDIS_PASSWORD=$REDIS_PASSWORD --image docker.io/bitnami/redis:7.2.5 --command -- sleep infinity
`,
  },
  {
    repo: "bitnami",
    repoUrl: "https://charts.bitnami.com/bitnami",
    repoDisplay: "Bitnami",
    name: "postgresql",
    description: "PostgreSQL (Postgres) is an open source object-relational database known for reliability and data integrity. ACID-compliant, it supports foreign keys, joins, views, triggers and stored procedures.",
    versions: [
      { version: "15.5.20", appVersion: "16.3.0", daysAgo: 8 },
      { version: "15.5.19", appVersion: "16.3.0", daysAgo: 20 },
      { version: "15.4.0", appVersion: "16.2.0", daysAgo: 70 },
    ],
    verified: true,
    logo: "371d5e57-34c4-46ef-909e-658c1502ced8",
    stars: 430,
    home: "https://bitnami.com",
    values: "auth:\n  ## @param auth.postgresPassword Password for the postgres admin user\n  postgresPassword: \"\"\n  database: \"\"\narchitecture: standalone\nprimary:\n  persistence:\n    size: 8Gi\n",
    objects: [["StatefulSet", "postgresql"], ["Service", "postgresql"], ["Service", "postgresql-hl"], ["Secret", "postgresql"], ["NetworkPolicy", "postgresql"]],
    notes: "PostgreSQL can be accessed via port 5432 on the following DNS name from within your cluster:\n\n    {{release}}-postgresql.{{namespace}}.svc.cluster.local\n",
  },
  {
    repo: "jetstack",
    repoUrl: "https://charts.jetstack.io",
    repoDisplay: "cert-manager",
    name: "cert-manager",
    description: "A Helm chart for cert-manager",
    versions: [
      { version: "v1.15.3", appVersion: "v1.15.3", daysAgo: 6 },
      { version: "v1.15.2", appVersion: "v1.15.2", daysAgo: 35 },
      { version: "v1.15.1", appVersion: "v1.15.1", daysAgo: 120 },
    ],
    official: true,
    verified: true,
    cncf: true,
    logo: "6d75ecff-a328-495b-a7fc-12cd84499974",
    stars: 997,
    home: "https://cert-manager.io",
    values: "crds:\n  # Install the cert-manager CRDs with the chart\n  enabled: false\nreplicaCount: 1\n",
    objects: [["Deployment", "cert-manager"], ["Deployment", "cert-manager-webhook"], ["Deployment", "cert-manager-cainjector"], ["Service", "cert-manager-webhook"], ["CustomResourceDefinition", "certificates.cert-manager.io"]],
    notes: "cert-manager has been deployed successfully!",
  },
  {
    repo: "ingress-nginx",
    repoUrl: "https://kubernetes.github.io/ingress-nginx",
    repoDisplay: "Ingress NGINX",
    name: "ingress-nginx",
    description: "Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer",
    versions: [{ version: "4.11.2", appVersion: "1.11.2", daysAgo: 10 }, { version: "4.11.1", appVersion: "1.11.1", daysAgo: 88 }],
    official: true,
    logo: "a4b7c1d2-0000-4c4c-9e9e-5f5f5f5f5f5f",
    stars: 420,
    home: "https://github.com/kubernetes/ingress-nginx",
    values: "controller:\n  replicaCount: 1\n  service:\n    type: LoadBalancer\n",
    objects: [["Deployment", "ingress-nginx-controller"], ["Service", "ingress-nginx-controller"], ["IngressClass", "nginx"]],
    notes: "The ingress-nginx controller has been installed.",
  },
  {
    repo: "prometheus-community",
    repoUrl: "https://prometheus-community.github.io/helm-charts",
    repoDisplay: "Prometheus community",
    name: "kube-prometheus-stack",
    description: "kube-prometheus-stack collects Kubernetes manifests, Grafana dashboards, and Prometheus rules combined with documentation and scripts.",
    versions: [{ version: "62.3.0", appVersion: "v0.76.0", daysAgo: 3 }, { version: "61.3.2", appVersion: "v0.75.2", daysAgo: 40 }],
    verified: true,
    stars: 380,
    home: "https://github.com/prometheus-operator/kube-prometheus",
    values: "grafana:\n  enabled: true\nalertmanager:\n  enabled: true\n",
    objects: [["Deployment", "grafana"], ["StatefulSet", "prometheus"], ["DaemonSet", "node-exporter"], ["Service", "grafana"]],
    notes: "kube-prometheus-stack has been installed.",
  },
  {
    repo: "argo",
    repoUrl: "https://argoproj.github.io/argo-helm",
    repoDisplay: "Argo",
    name: "argo-cd",
    description: "A Helm chart for Argo CD, a declarative, GitOps continuous delivery tool for Kubernetes.",
    versions: [{ version: "7.4.4", appVersion: "v2.12.1", daysAgo: 2 }, { version: "7.4.3", appVersion: "v2.12.0", daysAgo: 9 }],
    official: true,
    cncf: true,
    logo: "b8a3c1d2-1111-4c4c-9e9e-6f6f6f6f6f6f",
    stars: 640,
    home: "https://github.com/argoproj/argo-helm",
    values: "server:\n  replicas: 1\nconfigs:\n  params:\n    server.insecure: false\n",
    objects: [["Deployment", "argocd-server"], ["Deployment", "argocd-repo-server"], ["StatefulSet", "argocd-application-controller"], ["Service", "argocd-server"]],
    notes: "In order to access the server UI you have the following options:\n\n1. kubectl port-forward service/argocd-server -n {{namespace}} 8080:443\n",
  },
  {
    repo: "grafana",
    repoUrl: "https://grafana.github.io/helm-charts",
    repoDisplay: "Grafana",
    name: "loki",
    description: "Helm chart for Grafana Loki and Grafana Enterprise Logs supporting both simple, scalable and distributed modes.",
    versions: [{ version: "6.10.0", appVersion: "3.1.1", daysAgo: 5 }],
    official: true,
    stars: 210,
    home: "https://grafana.github.io/helm-charts",
    values: "deploymentMode: SimpleScalable\nloki:\n  auth_enabled: false\n",
    objects: [["StatefulSet", "loki-write"], ["Deployment", "loki-read"], ["Service", "loki-gateway"]],
    notes: "Loki has been installed.",
  },
  {
    repo: "kedacore",
    repoUrl: "https://kedacore.github.io/charts",
    repoDisplay: "KEDA",
    name: "keda",
    description: "Event-based autoscaler for workloads on Kubernetes",
    versions: [{ version: "2.15.1", appVersion: "2.15.1", daysAgo: 20 }],
    verified: true,
    cncf: true,
    stars: 150,
    home: "https://keda.sh",
    values: "operator:\n  replicaCount: 1\n",
    objects: [["Deployment", "keda-operator"], ["Deployment", "keda-operator-metrics-apiserver"]],
    notes: "KEDA is installed.",
  },
  {
    repo: "bitnami",
    repoUrl: "https://charts.bitnami.com/bitnami",
    repoDisplay: "Bitnami",
    name: "redis-cluster",
    description: "Redis(R) is an open source, scalable, distributed in-memory cache for applications. It can be used to store and serve data in the form of strings, hashes, lists, sets and sorted sets.",
    versions: [{ version: "10.2.9", appVersion: "7.2.5", daysAgo: 14 }],
    verified: true,
    logo: "e3f8a3f6-1d55-4a3f-8a52-3c1a9c1e0b11",
    stars: 90,
    home: "https://bitnami.com",
    values: "cluster:\n  nodes: 6\n",
    objects: [["StatefulSet", "redis-cluster"], ["Service", "redis-cluster"]],
    notes: "Redis Cluster is installed.",
  },
  {
    repo: "dandydev",
    repoUrl: "https://dandydeveloper.github.io/charts",
    repoDisplay: "DandyDeveloper",
    name: "redis-ha",
    description: "This Helm chart provides a highly available Redis implementation with a master/slave configuration and uses Sentinel sidecars for failover management",
    versions: [{ version: "4.27.6", appVersion: "7.2.4", daysAgo: 160 }],
    stars: 40,
    home: "https://redis.io",
    values: "replicas: 3\n",
    objects: [["StatefulSet", "redis-ha-server"], ["Service", "redis-ha"]],
    notes: "Redis HA is installed.",
  },
];

const LOGOS: Record<string, string> = {
  "e3f8a3f6-1d55-4a3f-8a52-3c1a9c1e0b11": svgLogo("#dc382d", '<path d="M14 26l18-8 18 8-18 8z" fill="#fff"/><path d="M14 34l18 8 18-8" stroke="#fff" stroke-width="4" fill="none"/>'),
  "371d5e57-34c4-46ef-909e-658c1502ced8": svgLogo("#336791", '<circle cx="32" cy="30" r="14" fill="#fff"/><circle cx="27" cy="27" r="3" fill="#336791"/>'),
  "6d75ecff-a328-495b-a7fc-12cd84499974": svgLogo("#326ce5", '<path d="M20 34l8 8 16-18" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>'),
  "b8a3c1d2-1111-4c4c-9e9e-6f6f6f6f6f6f": svgLogo("#ef7b4d", '<circle cx="32" cy="30" r="13" fill="#fff"/><circle cx="32" cy="30" r="6" fill="#ef7b4d"/>'),
};

const DEFAULT_REPOS = [
  { name: "bitnami", url: "https://charts.bitnami.com/bitnami" },
  { name: "ingress-nginx", url: "https://kubernetes.github.io/ingress-nginx" },
  { name: "jetstack", url: "https://charts.jetstack.io" },
  { name: "prometheus-community", url: "https://prometheus-community.github.io/helm-charts" },
];

const REPO_STORE = "harness-helm-repos";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "" });
const fail = (stderr: string) => ({ code: 1, signal: null, stdout: "", stderr });
const argValue = (args: string[], flag: string) => {
  const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i === -1) return undefined;
  return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
};

export function createHelmMocks(scenario: string) {
  const repos = (): { name: string; url: string }[] => {
    const stored = sessionStorage.getItem(REPO_STORE);
    if (stored) return JSON.parse(stored);
    return scenario === "helm-norepos" ? [] : DEFAULT_REPOS;
  };
  const storeRepos = (list: { name: string; url: string }[]) => sessionStorage.setItem(REPO_STORE, JSON.stringify(list));

  const releases = () => (scenario === "empty" ? [] : [...RELEASES, ...installed()]);
  const find = (context: string, namespace: string, name: string) =>
    releases().find((r) => r.context === context && r.namespace === namespace && r.name === name);
  const latest = (r: ReleaseDef) => r.revisions[r.revisions.length - 1];

  const chartMeta = (r: ReleaseDef, rev: RevisionDef) => ({
    name: r.chart,
    version: rev.chartVersion,
    appVersion: rev.appVersion,
    description: r.description,
    home: r.home ?? null,
    sources: r.sources ?? [],
    icon: null,
    keywords: [],
    maintainers: [{ name: "Platform team", email: "platform@acme.dev" }],
    kubeVersion: ">=1.25.0-0",
    deprecated: false,
    type: "application",
  });

  const detail = (r: ReleaseDef, rev: RevisionDef) => ({
    name: r.name,
    namespace: r.namespace,
    revision: rev.revision,
    status: rev.status,
    updated: iso(rev.hoursAgo),
    firstDeployed: iso(r.revisions[0].hoursAgo),
    description: rev.description,
    notes: r.notes?.(r) ?? "",
    chart: chartMeta(r, rev),
    values: rev.values,
    computedValues: { ...{ podAnnotations: {}, nodeSelector: {}, tolerations: [], serviceAccount: { create: true } }, ...rev.values },
    valuesSchema: null,
    manifest: r.manifest(rev.values, rev.revision),
    hooks: (r.hooks ?? []).map((h) => ({
      ...h,
      path: `${r.chart}/templates/hooks/${h.name}.yaml`,
      manifest: `apiVersion: v1\nkind: ${h.kind}\nmetadata:\n  name: ${h.name}\n`,
      startedAt: h.phase ? iso(rev.hoursAgo + 0.02) : null,
      completedAt: h.phase ? iso(rev.hoursAgo) : null,
    })),
  });

  const chartByRef = (reference: string) => {
    const [repo, name] = reference.split("/");
    const local = repos().find((r) => r.name === repo);
    return CATALOG.find((c) => c.name === name && (c.repo === repo || (local && c.repoUrl === local.url)));
  };

  const hubChart = (c: CatalogChart) => ({
    packageId: `00000000-0000-4000-8000-${String(CATALOG.indexOf(c)).padStart(12, "0")}`,
    name: c.name,
    displayName: null,
    description: c.description,
    version: c.versions[0].version,
    appVersion: c.versions[0].appVersion,
    repoName: c.repo,
    repoDisplayName: c.repoDisplay,
    repoUrl: c.repoUrl,
    logoImageId: c.logo ?? null,
    official: !!c.official,
    verifiedPublisher: !!c.verified,
    cncf: !!c.cncf,
    deprecated: false,
    signed: !!c.verified,
    stars: c.stars,
    updated: Math.floor((Date.now() - c.versions[0].daysAgo * 24 * HOUR) / 1000),
  });

  const readme = (c: CatalogChart) =>
    `# ${c.name}\n\n${c.description}\n\n## TL;DR\n\n\`\`\`console\nhelm install my-release ${c.repo}/${c.name}\n\`\`\`\n\n## Parameters\n\nSee \`values.yaml\` for every option.\n`;

  const renderInstall = (args: string[]) => {
    const name = args[1];
    const chart = chartByRef(args[2]);
    const namespace = argValue(args, "--namespace") ?? "default";
    if (!chart) return null;
    const manifest = chart.objects
      .map(([kind, objName]) =>
        doc(`${chart.name}/templates/${kind.toLowerCase()}.yaml`, `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}-${objName.replace(new RegExp(`^${chart.name}-?`), "") || chart.name}\n  namespace: ${namespace}\n`)
      )
      .join("");
    const notes = chart.notes.replace(/\{\{release\}\}/g, name).replace(/\{\{namespace\}\}/g, namespace);
    return { chart, manifest, notes, namespace };
  };

  /** `helm install … --output=json` with a values file (run_helm_with_values). */
  const install = async (args: string[], values: string) => {
    const dryRun = args.includes("--dry-run");
    await sleep(dryRun ? 900 : 1600);
    const rendered = renderInstall(args);
    if (!rendered) return { code: 1, stdout: "", stderr: `Error: INSTALLATION FAILED: chart "${args[2]}" not found in repository` };
    if (/replicaCount:\s*-/.test(values)) {
      return { code: 1, stdout: "", stderr: "Error: INSTALLATION FAILED: values don't meet the specifications of the schema(s) in the following chart(s):\nredis:\n- replica.replicaCount: Must be greater than or equal to 0" };
    }
    const context = argValue(args, "--kube-context") ?? "";
    const version = argValue(args, "--version") ?? rendered.chart.versions[0].version;
    const release = {
      name: args[1],
      namespace: rendered.namespace,
      version: 1,
      info: { status: dryRun ? "pending-install" : "deployed", notes: rendered.notes, description: dryRun ? "Dry run complete" : "Install complete" },
      manifest: rendered.manifest,
      hooks: [{ name: `${args[1]}-test-connection`, kind: "Pod", events: ["test"] }],
    };
    if (!dryRun) {
      const list = JSON.parse(sessionStorage.getItem(RELEASE_STORE) || "[]");
      list.push({
        context,
        name: args[1],
        namespace: rendered.namespace,
        chart: rendered.chart.name,
        repo: rendered.chart.repo,
        description: rendered.chart.description,
        home: rendered.chart.home,
        revisions: [{ revision: 1, status: "deployed", chartVersion: version, appVersion: rendered.chart.versions.find((v) => v.version === version)?.appVersion ?? "", values: {}, description: "Install complete", hoursAgo: 0 }],
        manifestText: rendered.manifest,
        notesText: rendered.notes,
      });
      sessionStorage.setItem(RELEASE_STORE, JSON.stringify(list));
    }
    return { code: 0, stdout: JSON.stringify(release), stderr: "" };
  };

  /** helm CLI calls of the Helm screens; null: not ours (setup.ts handles it). */
  const shell = async (args: string[]) => {
    if (args[0] === "repo") {
      if (args[1] === "list") {
        const list = repos();
        return list.length ? ok(JSON.stringify(list)) : fail("Error: no repositories to show");
      }
      if (args[1] === "add") {
        await sleep(700);
        const [, , name, url] = args;
        if (!/^https?:\/\//.test(url)) return fail(`Error: could not find protocol handler for: ${url}`);
        if (url.includes("example.invalid")) return fail(`Error: looks like "${url}" is not a valid chart repository or cannot be reached: failed to fetch ${url}/index.yaml : 404 Not Found`);
        storeRepos([...repos().filter((r) => r.name !== name), { name, url }]);
        return ok(`"${name}" has been added to your repositories\n`);
      }
      if (args[1] === "update") {
        await sleep(900);
        return ok("Hang tight while we grab the latest from your chart repositories...\nUpdate Complete. ⎈Happy Helming!⎈\n");
      }
      if (args[1] === "remove") {
        storeRepos(repos().filter((r) => r.name !== args[2]));
        return ok(`"${args[2]}" has been removed from your repositories\n`);
      }
    }
    if (args[0] === "search" && args[1] === "repo") {
      const query = args[2] && !args[2].startsWith("-") ? args[2].toLowerCase() : "";
      const local = repos();
      if (!local.length) return fail("Error: no repositories configured");
      const versions = args.includes("--versions");
      const rows = local.flatMap((repo) =>
        CATALOG.filter((c) => c.repoUrl === repo.url || c.repo === repo.name)
          .filter((c) => !query || `${repo.name}/${c.name} ${c.description}`.toLowerCase().includes(query))
          .flatMap((c) =>
            (versions ? c.versions.filter((v) => !v.prerelease) : [c.versions.find((v) => !v.prerelease) ?? c.versions[0]]).map((v) => ({
              name: `${repo.name}/${c.name}`,
              version: v.version,
              app_version: v.appVersion,
              description: c.description,
            }))
          )
      );
      // Charts of releases installed from the private "acme" repository.
      if (versions && /payments-api|checkout|feature-flags/.test(query)) {
        return null;
      }
      return ok(JSON.stringify(rows));
    }
    if (args[0] === "uninstall") {
      await sleep(600);
      return ok(`release "${args[1]}" uninstalled\n`);
    }
    return null;
  };

  const handlers: Record<string, (p: any) => unknown> = {
    helm_releases: async (p) => {
      await sleep(120);
      const namespaces: string[] = p.namespaces ?? [];
      const all = !namespaces.length || namespaces.includes("all");
      return releases()
        .filter((r) => r.context === p.context && (all || namespaces.includes(r.namespace)))
        .map((r) => {
          const rev = latest(r);
          return {
            name: r.name,
            namespace: r.namespace,
            revision: rev.revision,
            status: rev.status,
            chart: r.chart,
            chartVersion: rev.chartVersion,
            appVersion: rev.appVersion,
            updated: iso(rev.hoursAgo),
            description: rev.description,
            icon: null,
            storage: "secret",
          };
        });
    },
    helm_history: async (p) => {
      await sleep(120);
      const r = find(p.context, p.namespace, p.name);
      if (!r) throw { message: `release ${p.name} not found`, code: 404, reason: "NotFound" };
      return [...r.revisions].reverse().map((rev) => ({
        revision: rev.revision,
        status: rev.status,
        chart: r.chart,
        chartVersion: rev.chartVersion,
        appVersion: rev.appVersion,
        updated: iso(rev.hoursAgo),
        description: rev.description,
        values: rev.values,
      }));
    },
    helm_release_detail: async (p) => {
      await sleep(150);
      const r = find(p.context, p.namespace, p.name);
      if (!r) throw { message: `Release ${p.name} was not found in ${p.namespace}`, code: 404, reason: "NotFound" };
      const rev = p.revision ? r.revisions.find((x) => x.revision === p.revision) : latest(r);
      if (!rev) throw { message: `Revision ${p.revision} of ${p.name} was not found`, code: 404, reason: "NotFound" };
      return detail(r, rev);
    },
    helm_chart_inspect: async (p) => {
      await sleep(500);
      const chart = chartByRef(p.reference);
      if (!chart) throw `Error: chart "${p.reference}" not found`;
      const version = chart.versions.find((v) => v.version === p.version) ?? chart.versions[0];
      return {
        metadata: { name: chart.name, version: version.version, appVersion: version.appVersion, description: chart.description, home: chart.home, sources: [], keywords: [], maintainers: [], deprecated: false },
        values: chart.values,
        valuesSchema: chart.schema ?? null,
        readme: readme(chart),
      };
    },
    artifacthub_search: async (p) => {
      await sleep(450);
      const q = String(p.query ?? "").toLowerCase().trim();
      const hits = CATALOG.filter((c) => `${c.name} ${c.description} ${c.repo}`.toLowerCase().includes(q)).sort(
        (a, b) => Number(b.name === q) - Number(a.name === q) || b.stars - a.stars
      );
      return { total: hits.length, charts: hits.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 24)).map(hubChart) };
    },
    artifacthub_package: async (p) => {
      await sleep(300);
      const chart = CATALOG.find((c) => c.repo === p.repo && c.name === p.name);
      if (!chart) throw "Artifact Hub doesn't have this chart";
      return {
        ...hubChart(chart),
        homeUrl: chart.home,
        readme: readme(chart),
        keywords: [],
        links: [{ name: "source", url: chart.home }],
        license: "Apache-2.0",
        hasValuesSchema: !!chart.schema,
        versions: chart.versions.map((v) => ({ version: v.version, appVersion: v.appVersion, prerelease: !!v.prerelease, updated: Math.floor((Date.now() - v.daysAgo * 24 * HOUR) / 1000) })),
      };
    },
    artifacthub_values: async (p) => {
      await sleep(200);
      return CATALOG[Number(String(p.packageId).slice(-12))]?.values ?? "";
    },
    artifacthub_values_schema: async (p) => CATALOG[Number(String(p.packageId).slice(-12))]?.schema ?? null,
    artifacthub_logo: async (p) => {
      await sleep(80);
      if (!LOGOS[p.imageId]) throw "Artifact Hub doesn't have this logo";
      return LOGOS[p.imageId];
    },
  };

  return { handlers, shell, install };
}
