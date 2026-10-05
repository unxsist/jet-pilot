/*
 * Clouds besides AWS for the harness (src-tauri/src/clusters/providers):
 * Google Cloud and Azure through their CLIs, DigitalOcean (token or doctl),
 * Akamai/Linode, Civo, Scaleway and Vultr (API tokens) and Exoscale (API
 * key). cloud.ts delegates here.
 *
 * ?cli=missing|signedout, ?plugin=missing (see cloud.ts).
 */
export type OtherProvider = "gcp" | "azure" | "digitalocean" | "linode" | "civo" | "scaleway" | "vultr" | "exoscale";

type Send = (message: unknown) => void;
type Spec = [name: string, region: string, version: string, status?: string];

interface Connection {
  id: string;
  provider: string;
  kind: string;
  label: string;
  targets: { accountId: string; accountName: string | null; roleName: string }[];
  regions: string[];
  cliAccount?: string | null;
}

const params = new URLSearchParams(location.search);
const cliKnob = params.get("cli");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, message: string, field?: string) => ({ code, message, field: field ?? null });

/* Projects / subscriptions and their clusters. */
const SCOPES: Partial<Record<OtherProvider, { id: string; name: string; detail?: string; clusters: Spec[] }[]>> = {
  gcp: [
    { id: "acme-prod-381402", name: "acme-prod", clusters: [["checkout", "europe-west4", "1.32"], ["web", "us-central1", "1.31"]] },
    { id: "acme-staging-381402", name: "acme-staging", clusters: [["staging", "europe-west4", "1.32", "RECONCILING"]] },
    { id: "acme-data-381402", name: "acme-data", clusters: [["analytics", "europe-west1", "1.30"]] },
    { id: "sandbox-7781", name: "sandbox", clusters: [] },
  ],
  azure: [
    {
      id: "6f1c2a9e-4b1d-4c55-9a0e-2d7b8c1f0a11",
      name: "Production",
      detail: "Contoso · 6f1c2a9e-4b1d-4c55-9a0e-2d7b8c1f0a11",
      clusters: [["aks-weu-core", "westeurope", "1.31"], ["aks-neu-batch", "northeurope", "1.30"]],
    },
    {
      id: "0b7d5e3c-91a2-4f8e-8c6d-5a4b3c2d1e0f",
      name: "Development",
      detail: "Contoso · 0b7d5e3c-91a2-4f8e-8c6d-5a4b3c2d1e0f",
      clusters: [["aks-dev", "westeurope", "1.32"]],
    },
  ],
};

/* Account-wide providers: clusters per region. */
const CLUSTERS: Partial<Record<OtherProvider, Spec[]>> = {
  digitalocean: [["hobby", "ams3", "1.31"], ["staging", "fra1", "1.32"]],
  linode: [["lke-prod", "eu-central", "1.31"], ["lke-dev", "us-east", "1.32"]],
  civo: [["blog", "lon1", "1.30"], ["k3s-lab", "fra1", "1.31"]],
  scaleway: [["kapsule-prod", "fr-par", "1.31"], ["kapsule-dev", "nl-ams", "1.32", "UPDATING"]],
  vultr: [["vke-prod", "ams", "1.31"]],
  exoscale: [["sks-prod", "ch-gva-2", "1.31"], ["sks-dev", "de-fra-1", "1.32"]],
};

const REGIONS: Record<OtherProvider, string[]> = {
  gcp: [],
  azure: [],
  digitalocean: ["ams3", "blr1", "fra1", "lon1", "nyc1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
  linode: ["eu-central", "eu-west", "us-east", "us-central", "us-west", "ap-south", "ap-northeast"],
  civo: ["lon1", "fra1", "nyc1", "phx1"],
  scaleway: ["fr-par", "nl-ams", "pl-waw"],
  vultr: ["ams", "fra", "lhr", "ewr", "lax", "sgp", "nrt"],
  exoscale: ["ch-gva-2", "ch-dk-2", "de-fra-1", "de-muc-1", "at-vie-1", "at-vie-2", "bg-sof-1"],
};

const LABELS: Record<OtherProvider, string> = {
  gcp: "Google Cloud",
  azure: "Azure",
  digitalocean: "DigitalOcean",
  linode: "Akamai",
  civo: "Civo",
  scaleway: "Scaleway",
  vultr: "Vultr",
  exoscale: "Exoscale",
};

const id8 = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0");
/* Endpoints that look like each provider's, so provider detection recognises them. */
const endpoint = (provider: OtherProvider, name: string, region: string) => {
  const id = id8(`${provider}${name}`);
  switch (provider) {
    case "gcp":
      return `https://34.${(parseInt(id.slice(0, 2), 16) % 200) + 20}.${parseInt(id.slice(2, 4), 16)}.${parseInt(id.slice(4, 6), 16)}`;
    case "azure":
      return `https://${name}-dns-${id}.hcp.${region}.azmk8s.io:443`;
    case "digitalocean":
      return `https://${id}-4f2a-4c1e-9b7a-${id}abcd.k8s.ondigitalocean.com`;
    case "linode":
      return `https://${id}-1234-4c1e.${region === "eu-central" ? "eu-central-2" : "us-east-1"}.linodelke.net:443`;
    case "civo":
      return `https://${id}.k8s.civo.com:6443`;
    case "scaleway":
      return `https://${id}-7c1e-4b2a.api.k8s.${region}.scw.cloud:6443`;
    case "vultr":
      return `https://${id}-91a2-4f8e.vultr-k8s.com:6443`;
    case "exoscale":
      return `https://${id}.sks-${region}.exo.io:443`;
  }
};

const entry = (connection: Connection, provider: OtherProvider, scope: { id: string; name: string } | null, [name, region, version, status]: Spec) => ({
  key: `${provider}:${connection.id}:${scope?.id ?? "-"}:${region}:${name}`,
  provider,
  connectionId: connection.id,
  accountId: scope?.id ?? "",
  accountName: scope?.name ?? null,
  roleName: null,
  region,
  name,
  version,
  status: status ?? "RUNNING",
  endpoint: endpoint(provider, name, region),
  createdAt: Date.now() - 120 * 86400_000,
  state: "available",
  addedContext: null,
});

/* gcloud / az / doctl: signed in once a sign-in succeeds (this page). */
const scenario = params.get("scenario") ?? localStorage.getItem("harness-scenario");
const signedIn = new Set<OtherProvider>(
  cliKnob === "signedout" ? [] : scenario === "clouds" ? ["gcp", "digitalocean"] : ["gcp", "azure", "digitalocean"]
);
const sessions: (() => void)[] = [];

export const OTHER_CLOUDS = {
  pluginMissing: () => params.get("plugin") === "missing",

  cliStatus(provider: OtherProvider) {
    const tool = provider === "gcp" ? "gcloud" : provider === "azure" ? "az" : "doctl";
    const installed = cliKnob !== "missing";
    const accounts =
      provider === "gcp" ? ["dev@acme.example", "ops@acme.example"] : provider === "azure" ? ["dev@contoso.example"] : ["default"];
    const isIn = installed && signedIn.has(provider);
    const plugin =
      provider === "gcp"
        ? { name: "gke-gcloud-auth-plugin", installed: !OTHER_CLOUDS.pluginMissing(), managed: false, path: "/usr/lib/google-cloud-sdk/bin/gke-gcloud-auth-plugin" }
        : provider === "azure"
          ? { name: "kubelogin", installed: !OTHER_CLOUDS.pluginMissing(), managed: true, path: "~/.kube/jet-pilot/bin/kubelogin" }
          : null;
    return {
      tool,
      installed,
      version: installed ? { gcloud: "496.0.0", az: "2.65.0", doctl: "1.115.0" }[tool] : null,
      path: installed ? `/usr/local/bin/${tool}` : null,
      signedIn: isIn,
      account: isIn ? accounts[0] : null,
      accounts: isIn ? accounts : [],
      authPlugin: plugin,
      installUrl: {
        gcloud: "https://cloud.google.com/sdk/docs/install",
        az: "https://learn.microsoft.com/cli/azure/install-azure-cli",
        doctl: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
      }[tool],
      message: null,
    };
  },

  /* gcloud prints a URL to open; az a device code. */
  cliSignIn(provider: OtherProvider, send: Send, wait: boolean) {
    if (provider === "digitalocean") throw err("invalidInput", "Use an API token for DigitalOcean, or sign in with `doctl auth init` first.");
    const id = `cli-${provider}-${Math.random().toString(36).slice(2, 8)}`;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = () => {
      timers.forEach(clearTimeout);
      signedIn.add(provider);
      send({ type: "succeeded", expiresAt: null });
    };
    timers.push(
      setTimeout(() => {
        if (provider === "gcp") {
          send({ type: "started", command: "gcloud auth login --brief --quiet" });
          send({ type: "url", url: "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com" });
        } else {
          send({ type: "started", command: "az login --use-device-code" });
          send({ type: "deviceCode", userCode: "HK7Q-2MWX", verificationUri: "https://microsoft.com/devicelogin", verificationUriComplete: null });
        }
      }, 350)
    );
    if (!wait) timers.push(setTimeout(finish, 3500));
    sessions.push(finish);
    return id;
  },
  finishAll: () => sessions.splice(0).forEach((finish) => finish()),
  /* gcloud / az / doctl accounts are signed in as long as the CLI is. */
  isSignedIn: (provider: OtherProvider) => cliKnob !== "missing" && signedIn.has(provider),

  scopes: (provider: OtherProvider) => (SCOPES[provider] ?? []).map(({ id, name, detail }) => ({ id, name, detail: detail ?? null })),
  regions: (provider: OtherProvider) => REGIONS[provider] ?? [],

  create(spec: any) {
    const provider = (spec.provider ?? "exoscale") as OtherProvider;
    if (spec.kind === "cli") {
      if (cliKnob === "missing") throw err("invalidInput", `${LABELS[provider]}'s CLI isn't installed.`, "provider");
      const isIn = signedIn.has(provider);
      return {
        provider,
        kind: "cli",
        label: spec.label || (provider === "gcp" ? "acme (Google Cloud)" : provider === "azure" ? "Contoso" : "DigitalOcean"),
        cliAccount: spec.cliAccount ?? null,
        identity: isIn ? (spec.cliAccount ?? (provider === "gcp" ? "dev@acme.example" : provider === "azure" ? "dev@contoso.example" : "default")) : null,
        status: isIn ? "signedIn" : "signedOut",
        message: isIn ? null : `Sign in with ${provider === "gcp" ? "gcloud" : provider === "azure" ? "az" : "doctl"} first.`,
      };
    }
    if (spec.kind === "token") {
      if (String(spec.token).includes("bad")) throw err("invalidInput", `${LABELS[provider]} didn't accept this token (401 Unauthorized).`, "token");
      const team = { digitalocean: "Acme team", linode: "acme-ops", civo: "acme", scaleway: "Acme Org", vultr: "acme@vultr" }[provider as string];
      return { provider, kind: "token", label: spec.label || team, identity: team, projectId: spec.projectId ?? null, status: "signedIn" };
    }
    if (String(spec.key).toLowerCase().includes("bad")) throw err("invalidInput", "Exoscale didn't accept this key (403).", "key");
    return {
      provider: "exoscale",
      kind: "apiKey",
      label: spec.label || "Exoscale",
      identity: `${String(spec.key).slice(0, 10)}…`,
      exoscale: { user: spec.user ?? "jet-pilot", groups: spec.groups?.length ? spec.groups : ["system:masters"] },
      status: "signedIn",
    };
  },

  /* Progress per project / subscription or region, then the clusters. */
  async discover(connection: Connection, send: Send, known: { key: string; state: string; addedContext: unknown }[]) {
    const provider = connection.provider as OtherProvider;
    const found: ReturnType<typeof entry>[] = [];
    const remember = (cluster: ReturnType<typeof entry>) => {
      const before = known.find((c) => c.key === cluster.key);
      found.push(before ? { ...cluster, state: before.state, addedContext: before.addedContext as null } : cluster);
    };
    const scoped = SCOPES[provider];
    if (scoped) {
      const wanted = connection.targets.length ? scoped.filter((s) => connection.targets.some((t) => t.accountId === s.id)) : scoped;
      for (const scope of wanted) {
        const progress = { type: "progress", connectionId: connection.id, scope: scope.name, accountId: scope.id, accountName: scope.name, region: null };
        send({ ...progress, state: "running" });
        await sleep(350);
        const denied = scope.name === "sandbox";
        send({
          ...progress,
          state: denied ? "error" : "done",
          message: denied ? "Kubernetes Engine API has not been used in project sandbox-7781 before or it is disabled." : null,
        });
        scope.clusters.forEach((spec) => remember(entry(connection, provider, scope, spec)));
        send({ type: "clusters", connectionId: connection.id, clusters: found.filter((c) => c.accountId === scope.id) });
      }
      return found;
    }
    const regions = connection.regions.length ? connection.regions : REGIONS[provider];
    const perRegion = provider === "civo" || provider === "scaleway" || provider === "exoscale";
    for (const region of perRegion ? regions : [null]) {
      const scope = region ? `${connection.label} · ${region}` : connection.label;
      send({ type: "progress", connectionId: connection.id, scope, accountId: null, accountName: connection.label, region, state: "running" });
      await sleep(perRegion ? 140 : 500);
      send({ type: "progress", connectionId: connection.id, scope, accountId: null, accountName: connection.label, region, state: "done" });
      (CLUSTERS[provider] ?? []).filter(([, r]) => !region || r === region).forEach((spec) => remember(entry(connection, provider, null, spec)));
    }
    send({ type: "clusters", connectionId: connection.id, clusters: found });
    return found;
  },

  /* ?scenario=clouds: signed-in accounts (Azure needs a sign-in). */
  scenario(now: number) {
    const make = (connection: Partial<Connection> & Record<string, unknown>) =>
      ({ regions: [], targets: [], sso: null, profile: null, expiresAt: null, message: null, createdAt: now - 20 * 86400_000, ...connection }) as Connection;
    const gcp = make({ id: "conn-gcp", provider: "gcp", kind: "cli", label: "acme (Google Cloud)", identity: "dev@acme.example", cliAccount: null, status: "signedIn" });
    const azure = make({
      id: "conn-azure", provider: "azure", kind: "cli", label: "Contoso", identity: "dev@contoso.example", cliAccount: null,
      status: "signedOut", message: "The az session ended. Sign in with az again.",
      targets: [{ accountId: SCOPES.azure![0]!.id, accountName: "Production", roleName: "" }],
    });
    const doToken = make({ id: "conn-do", provider: "digitalocean", kind: "token", label: "Acme team", identity: "Acme team", status: "signedIn" });
    const exo = make({
      id: "conn-exo", provider: "exoscale", kind: "apiKey", label: "Exoscale", identity: "EXO1a2b3c4…", status: "signedIn",
      regions: ["ch-gva-2", "de-fra-1"], exoscale: { user: "jet-pilot", groups: ["system:masters"] },
    });
    const clusters = [
      ...SCOPES.gcp!.flatMap((scope) => scope.clusters.map((spec) => entry(gcp, "gcp", scope, spec))),
      ...SCOPES.azure!.slice(0, 1).flatMap((scope) => scope.clusters.map((spec) => entry(azure, "azure", scope, spec))),
      ...CLUSTERS.digitalocean!.map((spec) => entry(doToken, "digitalocean", null, spec)),
      ...CLUSTERS.exoscale!.map((spec) => entry(exo, "exoscale", null, spec)),
    ];
    return [
      { connection: gcp, clusters: clusters.filter((c) => c.connectionId === gcp.id) },
      { connection: azure, clusters: clusters.filter((c) => c.connectionId === azure.id) },
      { connection: doToken, clusters: clusters.filter((c) => c.connectionId === doToken.id) },
      { connection: exo, clusters: clusters.filter((c) => c.connectionId === exo.id) },
    ];
  },
};
