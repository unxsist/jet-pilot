/*
 * Clusters hub fixtures (?scenario=hub): kubeconfig files across providers,
 * cluster metadata (aliases, colours, folders, guardrails) and the statuses
 * the probe streams.
 */
import { CONTEXTS, HOME, KUBECONFIG } from "./fixtures";

type Auth = { kind: string; command?: string | null; awsProfile?: string | null; interactive?: string };
interface HubContext {
  name: string;
  cluster: string;
  server: string;
  user: string;
  namespace?: string;
  auth: Auth;
  problems?: { code: string; severity: string; message: string }[];
}

const aws = (profile: string): Auth => ({ kind: "exec", command: "aws", awsProfile: profile, interactive: "nonInteractive" });

export const HUB_FILES: Record<string, { origin: string; current?: string; contexts: HubContext[] }> = {
  [KUBECONFIG]: {
    origin: "default",
    current: CONTEXTS[0]!.name,
    contexts: [
      {
        name: CONTEXTS[0]!.name,
        cluster: "arn:aws:eks:eu-west-1:123456789012:cluster/prod",
        server: "https://4F1E2D3C.gr7.eu-west-1.eks.amazonaws.com",
        user: "prod-admin",
        namespace: CONTEXTS[0]!.namespace,
        auth: aws("prod-admin"),
      },
      {
        name: CONTEXTS[1]!.name,
        cluster: "staging",
        server: "https://staging.k8s.example.com:6443",
        user: "staging-oidc",
        namespace: CONTEXTS[1]!.namespace,
        auth: { kind: "exec", command: "kubelogin", interactive: "interactive" },
      },
      {
        name: "arn:aws:eks:us-east-1:123456789012:cluster/payments-dr",
        cluster: "arn:aws:eks:us-east-1:123456789012:cluster/payments-dr",
        server: "https://9A8B7C6D.yl4.us-east-1.eks.amazonaws.com",
        user: "dr",
        auth: aws("payments-dr"),
      },
    ],
  },
  [`${HOME}/.kube/gke.yaml`]: {
    origin: "directory",
    contexts: [
      {
        name: "gke_acme-prod_europe-west4_checkout",
        cluster: "gke_acme-prod_europe-west4_checkout",
        server: "https://34.91.12.7",
        user: "gke",
        auth: { kind: "exec", command: "gke-gcloud-auth-plugin", interactive: "nonInteractive" },
      },
      {
        name: "gke_acme-dev_europe-west4_sandbox",
        cluster: "gke_acme-dev_europe-west4_sandbox",
        server: "https://34.91.80.2",
        user: "gke",
        auth: { kind: "exec", command: "gke-gcloud-auth-plugin", interactive: "nonInteractive" },
      },
    ],
  },
  [`${HOME}/.kube/aks.yaml`]: {
    origin: "directory",
    contexts: [
      {
        name: "aks-weu-analytics",
        cluster: "aks-weu-analytics",
        server: "https://aks-weu-analytics-dns-8f2c1a.hcp.westeurope.azmk8s.io:443",
        user: "clusterUser_analytics",
        auth: { kind: "exec", command: "kubelogin", interactive: "nonInteractive" },
      },
    ],
  },
  [`${HOME}/.kube/config.d/side-projects.yaml`]: {
    origin: "configD",
    contexts: [
      {
        name: "do-ams3-hobby",
        cluster: "do-ams3-hobby",
        server: "https://5d1e8a0b-2c4f.k8s.ondigitalocean.com",
        user: "do-ams3-hobby-admin",
        auth: { kind: "token", interactive: "nonInteractive" },
      },
      {
        name: "lke148202-ctx",
        cluster: "lke148202",
        server: "https://8f3a9c1d-e2b4.eu-central.linodelke.net:443",
        user: "lke148202-admin",
        auth: { kind: "token", interactive: "nonInteractive" },
      },
      {
        name: "admin@k8s-blog",
        cluster: "k8s-blog",
        server: "https://5b2f-4a7c.api.k8s.nl-ams.scw.cloud:6443",
        user: "admin",
        auth: { kind: "token", interactive: "nonInteractive" },
      },
      {
        name: "kind-dev",
        cluster: "kind-dev",
        server: "https://127.0.0.1:52341",
        user: "kind-dev",
        auth: { kind: "clientCert", interactive: "nonInteractive" },
      },
      {
        name: "docker-desktop",
        cluster: "docker-desktop",
        server: "https://kubernetes.docker.internal:6443",
        user: "docker-desktop",
        auth: { kind: "clientCert", interactive: "nonInteractive" },
        problems: [{ code: "fileRefMissing", severity: "error", message: "client-key file ~/.docker/kube/key.pem doesn't exist" }],
      },
    ],
  },
};

/* Metadata the user set (state.json `clusters`). */
export const HUB_CLUSTER_RECORDS = [
  { kubeConfig: KUBECONFIG, context: CONTEXTS[0]!.name, alias: "Payments prod", color: "red", env: "prod", folder: "Payments", favorite: true, tags: ["eu"] },
  { kubeConfig: KUBECONFIG, context: CONTEXTS[1]!.name, alias: "Payments staging", color: "amber", env: "staging", folder: "Payments" },
  { kubeConfig: KUBECONFIG, context: "arn:aws:eks:us-east-1:123456789012:cluster/payments-dr", alias: "Payments DR", env: "prod", readOnly: true, folder: "Payments" },
  { kubeConfig: `${HOME}/.kube/gke.yaml`, context: "gke_acme-prod_europe-west4_checkout", alias: "Checkout", color: "blue", env: "prod", folder: "Storefront", favorite: true },
  { kubeConfig: `${HOME}/.kube/gke.yaml`, context: "gke_acme-dev_europe-west4_sandbox", alias: "Sandbox", env: "dev", folder: "Storefront", tags: ["shared"] },
  { kubeConfig: `${HOME}/.kube/aks.yaml`, context: "aks-weu-analytics", alias: "Analytics", color: "violet", folder: "Data" },
  { kubeConfig: `${HOME}/.kube/config.d/side-projects.yaml`, context: "docker-desktop", hidden: true },
];

const now = () => Date.now();

/* What the probe reports per context (missing: reachable with defaults). */
export function hubStatus(context: string, kubeConfig: string, interactive: string) {
  const base = { context, kubeConfig, checkedAt: now(), interactive, authCommand: null as string | null };
  if (interactive === "interactive") {
    return { ...base, reachability: "skipped", message: "Sign-in needed to check this cluster", lastOkAt: now() - 3 * 3600_000 };
  }
  switch (context) {
    case "aks-weu-analytics":
      return { ...base, reachability: "unreachable", message: "Timed out after 5 s", lastOkAt: now() - 2 * 86400_000 };
    case "gke_acme-dev_europe-west4_sandbox":
      return { ...base, reachability: "unauthorized", message: "The credentials were rejected (401). Sign in with gcloud again.", lastOkAt: now() - 6 * 3600_000 };
    case "docker-desktop":
      return { ...base, reachability: "error", message: "client-key file ~/.docker/kube/key.pem doesn't exist" };
  }
  const versions: Record<string, [string, number]> = {
    [CONTEXTS[0]!.name]: ["v1.31.4-eks-2d5f260", 12],
    "arn:aws:eks:us-east-1:123456789012:cluster/payments-dr": ["v1.31.4-eks-2d5f260", 3],
    "gke_acme-prod_europe-west4_checkout": ["v1.32.2-gke.1182003", 9],
    "do-ams3-hobby": ["v1.30.6", 2],
    "lke148202-ctx": ["v1.31.0", 3],
    "admin@k8s-blog": ["v1.30.4", 1],
    "kind-dev": ["v1.32.0", 1],
  };
  const [version, nodes] = versions[context] ?? ["v1.31.2", 3];
  return { ...base, reachability: "reachable", serverVersion: version, nodeCount: nodes, latencyMs: 40 + (context.length * 7) % 160, lastOkAt: now() };
}
