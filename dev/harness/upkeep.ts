/*
 * Harness fixtures and mocks for the Health page's Risks and Upgrades tabs:
 *
 * - `tls_certificates` (src-tauri/src/certificates.rs): the TLS Secrets of
 *   the fixture clusters with their expiry (one manual certificate expires
 *   in 2 days, one in 12);
 * - `helm_manifest_apis` (src-tauri/src/helm/apis.rs): the objects of each
 *   Helm release, with a Karpenter release that still renders a
 *   flowcontrol v1beta3 FlowSchema (removed in 1.32);
 * - `/version`: prod-eu-west-1 runs EKS 1.31 (extended support ends soon),
 *   staging-us-east-2 upstream 1.35;
 * - the kubeconfig credential of staging-us-east-2 is a client certificate
 *   that expires in 6 days (?contexts=2);
 * - the prod cluster's workloads get the probes, security contexts and
 *   budgets a well-run cluster has, minus a realistic handful of gaps, plus
 *   a bare debug pod, an Ingress last applied with networking.k8s.io/v1beta1,
 *   a Service that selects nothing, a leftover claim and volume, and a
 *   Deployment scaled to zero two months ago.
 *
 * ?scenario=upkeep-clean: a cluster with nothing to report (both tabs'
 * empty and healthy states).
 *
 * installUpkeepMocks() wraps the IPC after the auth mocks (setup.ts).
 */
import { CLUSTERS, CONTEXTS } from "./fixtures";
import { registerKubeRoutes } from "./kubeApi";

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const [PROD, STAGING] = [CONTEXTS[0]!.name, CONTEXTS[1]!.name];

const VERSIONS: Record<string, string> = {
  [PROD]: "v1.31.4-eks-2d5f260",
  [STAGING]: "v1.35.1",
};

/* ------------------------------------------------------------ fixtures -- */

const prod = CLUSTERS[PROD]!;
const staging = CLUSTERS[STAGING]!;
const byName = (list: any[], name: string) => list.find((o) => o.metadata?.name === name);

const probe = (port: number, path: string) => ({ httpGet: { path, port }, periodSeconds: 10 });
const noProbes = new Set(["ledger", "image-resizer"]);
const noLiveness = new Set(["grafana"]);
const asRoot = new Set(["nginx", "grafana", "alertmanager"]);
for (const deployment of prod.deployments) {
  const name = deployment.metadata.name;
  const spec = deployment.spec.template.spec;
  if (!asRoot.has(name)) spec.securityContext = { runAsNonRoot: true, runAsUser: 10001 };
  spec.containers = spec.containers.map((c: any) => {
    const port = c.ports?.[0]?.containerPort;
    if (!port || noProbes.has(name)) return c;
    return {
      ...c,
      readinessProbe: probe(port, "/ready"),
      ...(noLiveness.has(name) ? {} : { livenessProbe: probe(port, "/healthz") }),
    };
  });
}
for (const set of [...(prod.statefulsets ?? []), ...(prod.daemonsets ?? [])]) {
  if (set.metadata.name === "node-exporter") continue;
  set.spec.template.spec.securityContext = { runAsNonRoot: true, runAsUser: 999 };
}

/* Grafana's admin password as a plain env value; Prometheus keeps its data in an emptyDir. */
const grafana = byName(prod.deployments, "grafana").spec.template.spec;
grafana.containers[0].env = [...(grafana.containers[0].env ?? []), { name: "GF_SECURITY_ADMIN_PASSWORD", value: "change-me" }];
byName(prod.deployments, "prometheus").spec.template.spec.volumes = [{ name: "prometheus-db", emptyDir: {} }];

/* node-exporter reads the host: its network, processes and file systems. */
const exporter = byName(prod.daemonsets, "node-exporter").spec.template.spec;
Object.assign(exporter, {
  hostNetwork: true,
  hostPID: true,
  volumes: [
    { name: "proc", hostPath: { path: "/proc" } },
    { name: "sys", hostPath: { path: "/sys" } },
  ],
});

/* The backup job pulls whatever :latest is today. */
const backup = byName(prod.cronjobs, "db-backup").spec.jobTemplate.spec.template.spec;
backup.containers[0].image = "ghcr.io/acme/pg-backup:latest";

/* Budgets for the workloads a platform team cares about most. */
const budget = (name: string, namespace: string, labels: Record<string, string>, expected: number) => ({
  apiVersion: "policy/v1",
  kind: "PodDisruptionBudget",
  metadata: { name, namespace, uid: `upkeep-pdb-${name}`, creationTimestamp: iso(40 * DAY) },
  spec: { maxUnavailable: 1, selector: { matchLabels: labels } },
  status: { currentHealthy: expected, desiredHealthy: expected - 1, disruptionsAllowed: 1, expectedPods: expected },
});
prod.poddisruptionbudgets!.push(
  budget("ledger", "payments", { "app.kubernetes.io/name": "ledger" }, 2),
  budget("checkout-web", "checkout", { "app.kubernetes.io/name": "checkout-web" }, 3),
  budget("ingress-nginx-controller", "ingress-nginx", { "app.kubernetes.io/name": "ingress-nginx-controller" }, 2),
  budget("postgres", "payments", { "app.kubernetes.io/name": "postgres" }, 2)
);

/* A debug pod someone started by hand. */
const debugNode = prod.nodes[1].metadata.name;
prod.pods.push({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "netshoot-maria", namespace: "payments", uid: "upkeep-pod-netshoot", creationTimestamp: iso(3 * DAY), labels: { run: "netshoot-maria" } },
  spec: { nodeName: debugNode, containers: [{ name: "netshoot", image: "nicolaka/netshoot:v0.13", command: ["sleep", "infinity"] }], restartPolicy: "Never" },
  status: {
    phase: "Running",
    podIP: "10.42.7.19",
    startTime: iso(3 * DAY),
    conditions: [{ type: "Ready", status: "True", lastTransitionTime: iso(3 * DAY) }],
    containerStatuses: [{ name: "netshoot", image: "nicolaka/netshoot:v0.13", ready: true, started: true, restartCount: 0, state: { running: { startedAt: iso(3 * DAY) } } }],
  },
});

/* legacy-site was applied years ago with networking.k8s.io/v1beta1, and points at a Service without pods. */
const legacy = byName(prod.ingresses, "legacy-site");
legacy.metadata.annotations = {
  "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
    apiVersion: "networking.k8s.io/v1beta1",
    kind: "Ingress",
    metadata: { name: "legacy-site", namespace: "default" },
    spec: { rules: [{ host: "www.acme.dev", http: { paths: [{ path: "/", backend: { serviceName: "legacy-frontend", servicePort: 80 } }] } }] },
  }),
};
legacy.metadata.managedFields = [
  { manager: "kubectl-client-side-apply", operation: "Update", apiVersion: "networking.k8s.io/v1beta1", time: iso(1400 * DAY) },
];
prod.services.push({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "legacy-frontend", namespace: "default", uid: "upkeep-svc-legacy", creationTimestamp: iso(1400 * DAY) },
  spec: { type: "ClusterIP", clusterIP: "172.20.3.77", ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }], selector: { app: "legacy-frontend" } },
  status: {},
});

/* Left over from when postgres ran three replicas, and an old uploads volume. */
prod.persistentvolumeclaims!.push({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: { name: "data-postgres-2", namespace: "payments", uid: "upkeep-pvc-pg2", creationTimestamp: iso(120 * DAY), labels: { "app.kubernetes.io/name": "postgres" } },
  spec: { accessModes: ["ReadWriteOnce"], storageClassName: "gp3", volumeName: "pvc-7f3a91c2", resources: { requests: { storage: "50Gi" } } },
  status: { phase: "Bound", capacity: { storage: "50Gi" } },
});
prod.persistentvolumes!.push(
  {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "pvc-7f3a91c2", uid: "upkeep-pv-pg2", creationTimestamp: iso(120 * DAY) },
    spec: { capacity: { storage: "50Gi" }, storageClassName: "gp3", claimRef: { name: "data-postgres-2", namespace: "payments" }, accessModes: ["ReadWriteOnce"], persistentVolumeReclaimPolicy: "Delete" },
    status: { phase: "Bound" },
  },
  {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "pvc-2c81d0e4", uid: "upkeep-pv-uploads", creationTimestamp: iso(300 * DAY) },
    spec: { capacity: { storage: "100Gi" }, storageClassName: "gp3", claimRef: { name: "uploads", namespace: "checkout" }, accessModes: ["ReadWriteOnce"], persistentVolumeReclaimPolicy: "Retain" },
    status: { phase: "Released" },
  }
);

/* A reporting job nobody turned back on. */
const idleLabels = { "app.kubernetes.io/name": "legacy-reports" };
prod.deployments.push({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "legacy-reports",
    namespace: "checkout",
    uid: "upkeep-deploy-legacy-reports",
    generation: 4,
    creationTimestamp: iso(400 * DAY),
    labels: idleLabels,
    managedFields: [{ manager: "kubectl", operation: "Update", apiVersion: "apps/v1", time: iso(74 * DAY), fieldsType: "FieldsV1" }],
  },
  spec: {
    replicas: 0,
    selector: { matchLabels: idleLabels },
    template: {
      metadata: { labels: idleLabels },
      spec: {
        securityContext: { runAsNonRoot: true, runAsUser: 10001 },
        containers: [{ name: "reports", image: "ghcr.io/acme/reports:v0.3.2", resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "512Mi" } } }],
      },
    },
  },
  status: { observedGeneration: 4, replicas: 0 },
});

/* Staging runs upstream 1.35 on nodes of the same version. */
for (const node of staging.nodes) node.status.nodeInfo.kubeletVersion = "v1.35.1";

/* ------------------------------------------------------- TLS secrets -- */

/* Days left per TLS Secret; `certificate`: the cert-manager Certificate behind it. */
const TLS: Record<string, Record<string, { days: number; host: string; certificate?: string }>> = {
  [PROD]: {
    "ingress-nginx/tls-acme-dev": { days: 12, host: "acme.dev" },
    "payments/partner-api-tls": { days: 2, host: "partner.acme.dev" },
    "checkout/checkout-tls": { days: 23, host: "checkout.acme.dev", certificate: "checkout-tls" },
    "payments/api-acme-dev-tls": { days: 53, host: "api.acme.dev", certificate: "api-acme-dev" },
  },
  [STAGING]: {
    "ingress-nginx/tls-acme-dev": { days: 41, host: "staging.acme.dev" },
  },
};
prod.secrets.push({
  apiVersion: "v1",
  kind: "Secret",
  type: "kubernetes.io/tls",
  metadata: { name: "partner-api-tls", namespace: "payments", uid: "upkeep-secret-partner", creationTimestamp: iso(363 * DAY) },
  data: { "tls.crt": "", "tls.key": "" },
});

function tlsCertificates(context: string, namespaces: string[]) {
  const all = !namespaces.length || namespaces.includes("all");
  return Object.entries(TLS[context] ?? {})
    .map(([key, cert]) => {
      const [namespace, name] = key.split("/") as [string, string];
      const notAfter = NOW + cert.days * DAY;
      return {
        name,
        namespace,
        notAfter,
        notBefore: notAfter - 365 * DAY,
        subject: cert.host,
        dnsNames: [cert.host, `www.${cert.host}`],
        certificate: cert.certificate ?? null,
        error: null,
      };
    })
    .filter((c) => all || namespaces.includes(c.namespace))
    .sort((a, b) => a.notAfter - b.notAfter);
}

/* ------------------------------------------------- Helm manifest APIs -- */

const object = (apiVersion: string, kind: string, name: string) => ({ apiVersion, kind, name });

const RELEASES: Record<string, any[]> = {
  [PROD]: [
    { name: "cert-manager", namespace: "cert-manager", chart: "cert-manager", chartVersion: "v1.15.1", appVersion: "v1.15.1", objects: [object("apps/v1", "Deployment", "cert-manager"), object("apps/v1", "Deployment", "cert-manager-webhook"), object("apiextensions.k8s.io/v1", "CustomResourceDefinition", "certificates.cert-manager.io")] },
    { name: "checkout", namespace: "checkout", chart: "checkout", chartVersion: "3.2.0", appVersion: "3.2.0", objects: [object("apps/v1", "Deployment", "checkout-api"), object("autoscaling/v2", "HorizontalPodAutoscaler", "checkout-web"), object("networking.k8s.io/v1", "Ingress", "checkout")] },
    { name: "feature-flags", namespace: "platform", chart: "feature-flags", chartVersion: "0.22.0", appVersion: "0.22.0", objects: [object("apps/v1", "Deployment", "feature-flags"), object("v1", "Service", "feature-flags")] },
    { name: "ingress-nginx", namespace: "ingress-nginx", chart: "ingress-nginx", chartVersion: "4.11.1", appVersion: "1.11.1", objects: [object("apps/v1", "Deployment", "ingress-nginx-controller"), object("admissionregistration.k8s.io/v1", "ValidatingWebhookConfiguration", "ingress-nginx-admission")] },
    {
      name: "karpenter",
      namespace: "kube-system",
      chart: "karpenter",
      chartVersion: "0.37.0",
      appVersion: "0.37.0",
      objects: [
        object("apps/v1", "Deployment", "karpenter"),
        object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", "karpenter-leader-election"),
        object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", "karpenter-workload"),
        object("policy/v1", "PodDisruptionBudget", "karpenter"),
      ],
    },
    { name: "kube-prometheus-stack", namespace: "monitoring", chart: "kube-prometheus-stack", chartVersion: "61.3.2", appVersion: "v0.75.2", objects: [object("apps/v1", "Deployment", "kube-prometheus-stack-operator"), object("monitoring.coreos.com/v1", "Prometheus", "kube-prometheus-stack-prometheus")] },
    { name: "payments-api", namespace: "payments", chart: "payments-api", chartVersion: "2.14.3", appVersion: "2.14.3", objects: [object("apps/v1", "Deployment", "payments-api"), object("policy/v1", "PodDisruptionBudget", "payments-api")] },
  ],
  [STAGING]: [
    { name: "payments-api", namespace: "payments", chart: "payments-api", chartVersion: "2.15.0", appVersion: "2.15.0", objects: [object("apps/v1", "Deployment", "payments-api")] },
  ],
};

function manifestApis(context: string, namespaces: string[]) {
  const all = !namespaces.length || namespaces.includes("all");
  return (RELEASES[context] ?? [])
    .filter((r) => all || namespaces.includes(r.namespace))
    .map((r) => ({ revision: 1, error: null, ...r }));
}

/* --------------------------------------------------------------- mocks -- */

/* Read from the URL: setup.ts stores the knob only after the modules load. */
const clean = new URLSearchParams(location.search).get("scenario") === "upkeep-clean";
if (clean) {
  VERSIONS[PROD] = "v1.35.4-eks-0a1b2c3";
  registerKubeRoutes([
    {
      // Every list the checks read: empty, but for nodes on the cluster's version.
      method: "GET",
      path: /^\/(?:api\/v1|apis\/[^/]+\/[^/]+)\/(?:namespaces\/[^/]+\/)?([a-z0-9]+)$/,
      handle: (_request, match) =>
        match[1] === "nodes"
          ? { items: staging.nodes.map((n: any) => ({ ...n, status: { ...n.status, nodeInfo: { ...n.status.nodeInfo, kubeletVersion: "v1.35.4-eks-0a1b2c3" } } })) }
          : { items: [] },
    },
  ]);
}

registerKubeRoutes([
  {
    method: "GET",
    path: /^\/version$/,
    handle: (request) => ({ major: "1", minor: (VERSIONS[request.context] ?? "v1.31.2").split(".")[1], gitVersion: VERSIONS[request.context] ?? "v1.31.2", platform: "linux/amd64" }),
  },
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function installUpkeepMocks() {
  const internals = (window as any).__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = async (cmd: string, args: any = {}, options?: unknown) => {
    switch (cmd) {
      case "tls_certificates":
        await sleep(180);
        return clean ? [] : tlsCertificates(args.context, args.namespaces ?? ["all"]);
      case "helm_manifest_apis":
        await sleep(260);
        return clean ? [] : manifestApis(args.context, args.namespaces ?? ["all"]);
      case "auth_credential_status": {
        const statuses = await invoke(cmd, args, options);
        return (statuses ?? []).map((s: any) =>
          s.context === STAGING ? { ...s, kind: "clientCert", state: "valid", canSignIn: false, expiresAt: NOW + 6 * DAY + 3 * 3_600_000 } : s
        );
      }
    }
    return invoke(cmd, args, options);
  };
}

