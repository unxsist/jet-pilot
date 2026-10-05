/*
 * Where a cluster runs, guessed from its kubeconfig entry: the context name
 * (EKS ARNs, GKE paths), the API server host and the exec plugin.
 */

export type ProviderId =
  | "aws"
  | "gcp"
  | "azure"
  | "digitalocean"
  | "linode"
  | "civo"
  | "scaleway"
  | "vultr"
  | "exoscale"
  | "local"
  | "other";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Account / project / subscription when it can be read from the entry. */
  account?: string;
  region?: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  aws: "Amazon EKS",
  gcp: "Google GKE",
  azure: "Azure AKS",
  digitalocean: "DigitalOcean",
  linode: "Akamai / Linode",
  civo: "Civo",
  scaleway: "Scaleway",
  vultr: "Vultr",
  exoscale: "Exoscale",
  local: "Local",
  other: "Other",
};

export interface ProviderInput {
  context: string;
  cluster?: string | null;
  server?: string | null;
  /** Exec plugin basename. */
  authCommand?: string | null;
}

const hostOf = (server?: string | null) => {
  if (!server) return "";
  try {
    return new URL(server).hostname.toLowerCase();
  } catch {
    return server.toLowerCase();
  }
};

const LOCAL_NAMES = /^(kind-|k3d-|minikube$|docker-desktop$|docker-for-desktop$|rancher-desktop$|orbstack$|colima)/;

export function detectProvider(input: ProviderInput): ProviderInfo {
  const host = hostOf(input.server);
  const names = [input.context, input.cluster ?? ""];
  const make = (id: ProviderId, account?: string, region?: string): ProviderInfo => ({
    id,
    label: PROVIDER_LABELS[id],
    ...(account ? { account } : {}),
    ...(region ? { region } : {}),
  });

  for (const name of names) {
    const arn = /^arn:aws[\w-]*:eks:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/.exec(name);
    if (arn) return make("aws", arn[2], arn[1]);
    const gke = /^gke_([^_]+)_([^_]+)_(.+)$/.exec(name);
    if (gke) return make("gcp", gke[1], gke[2]);
  }
  const eks = /\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.eks\.amazonaws\.com(?:\.cn)?$/.exec(host);
  if (eks || host.endsWith(".eks.amazonaws.com")) return make("aws", undefined, eks?.[1]);
  const aks = /\.hcp\.([a-z0-9]+)\.azmk8s\.io$/.exec(host) ?? /\.([a-z0-9]+)\.azmk8s\.io$/.exec(host);
  if (aks) return make("azure", undefined, aks[1]);
  if (host.endsWith(".k8s.ondigitalocean.com")) {
    const region = /^do-([a-z]+\d)-/.exec(input.context)?.[1];
    return make("digitalocean", undefined, region);
  }
  const lke = /\.([a-z]{2}-[a-z]+(?:-\d)?)\.linodelke\.net$/.exec(host);
  if (lke || host.endsWith(".linodelke.net")) return make("linode", undefined, lke?.[1]);
  const scw = /\.api\.k8s\.([a-z]{2}-[a-z]{3})\.scw\.cloud$/.exec(host);
  if (scw || host.endsWith(".scw.cloud")) return make("scaleway", undefined, scw?.[1]);
  if (host.endsWith(".vultr-k8s.com")) return make("vultr");
  const sks = /\.sks-([a-z]{2}-[a-z]{3}-\d)\.exo\.io$/.exec(host);
  if (sks || host.endsWith(".exo.io")) return make("exoscale", undefined, sks?.[1]);
  if (host.endsWith(".civo.com") || host.includes(".k8s.civo.")) return make("civo");

  const command = (input.authCommand ?? "").toLowerCase();
  if (command === "aws" || command === "aws-iam-authenticator") return make("aws");
  if (command === "gke-gcloud-auth-plugin") return make("gcp");
  // "kubelogin" is both Azure's plugin and an OIDC plugin: only the server tells.
  if (command === "doctl") return make("digitalocean");

  if (
    LOCAL_NAMES.test(input.context) ||
    /^(localhost|127\.\d+\.\d+\.\d+|::1|host\.docker\.internal|kubernetes\.docker\.internal)$/.test(host)
  ) {
    return make("local");
  }
  return make("other");
}

/** Which local tool runs a local cluster (for its mark). */
export function localFlavor(context: string): "docker" | "rancher" | "k3s" | "kubernetes" {
  if (/^docker-(desktop|for-desktop)$/.test(context)) return "docker";
  if (context === "rancher-desktop") return "rancher";
  if (context.startsWith("k3d-")) return "k3s";
  return "kubernetes";
}
