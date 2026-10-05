/*
 * Cloud accounts and the cluster catalog (src-tauri/src/clusters/
 * {connections,catalog}.rs, providers/aws): IAM Identity Center sign-in with
 * a device code, accounts and roles, ~/.aws profiles, access keys, and EKS
 * discovery across accounts and regions. State lives in sessionStorage.
 *
 * ?scenario=cloud   three AWS accounts (one signed out) with added, available,
 *                   ignored and removed clusters
 * ?scenario=clouds  AWS, Google Cloud, Azure (signed out), DigitalOcean and
 *                   Exoscale accounts with their clusters
 * ?cli=missing|signedout   gcloud / az / doctl aren't installed / signed in
 * ?plugin=missing   gke-gcloud-auth-plugin and kubelogin aren't installed
 * ?ssowait=1        the device-code sign-in waits for __harnessFinishSso()
 * Access keys containing "BAD" are refused.
 */
import { MANAGED_KUBECONFIG } from "./managed";
import { OTHER_CLOUDS, type OtherProvider } from "./clouds";

type Channel = { id: number };
type Send = (channel: Channel, message: unknown) => void;

interface Connection {
  id: string;
  provider: string;
  kind: "sso" | "profile" | "keys" | "cli" | "token" | "apiKey";
  cliAccount?: string | null;
  projectId?: string | null;
  exoscale?: { user: string; groups: string[] } | null;
  label: string;
  identity: string | null;
  sso: { startUrl: string; region: string } | null;
  profile: string | null;
  regions: string[];
  targets: { accountId: string; accountName: string | null; roleName: string }[];
  status: "signedIn" | "expired" | "signedOut" | "error";
  expiresAt: number | null;
  message: string | null;
  createdAt: number;
}

interface CatalogEntry {
  key: string;
  provider: string;
  connectionId: string;
  accountId: string;
  accountName: string | null;
  roleName: string | null;
  region: string;
  name: string;
  version: string | null;
  status: string | null;
  endpoint: string | null;
  createdAt: number | null;
  state: "available" | "added" | "ignored" | "removed";
  addedContext: { context: string; kubeConfig: string } | null;
}

const ACCOUNTS = [
  { accountId: "210987654321", accountName: "acme-production", email: "aws-production@acme.example", roles: ["AdministratorAccess", "EKSClusterAdmin", "ReadOnlyAccess"] },
  { accountId: "345678901234", accountName: "acme-staging", email: "aws-staging@acme.example", roles: ["AdministratorAccess", "EKSClusterAdmin", "ReadOnlyAccess"] },
  { accountId: "456789012345", accountName: "acme-sandbox", email: "aws-sandbox@acme.example", roles: ["AdministratorAccess", "PowerUserAccess"] },
  { accountId: "567890123456", accountName: "acme-data-platform", email: "aws-data@acme.example", roles: ["EKSClusterAdmin", "ReadOnlyAccess"] },
  { accountId: "678901234567", accountName: "acme-security-audit", email: "aws-security@acme.example", roles: ["ReadOnlyAccess", "SecurityAudit"] },
  { accountId: "789012345678", accountName: "acme-shared-services", email: "aws-shared@acme.example", roles: ["EKSClusterAdmin", "NetworkAdministrator"] },
];

/* EKS clusters per account: [name, region, version, status]. */
const CLUSTERS: Record<string, [string, string, string, string][]> = {
  "210987654321": [
    ["prod-eu", "eu-west-1", "1.31", "ACTIVE"],
    ["prod-us", "us-east-1", "1.31", "ACTIVE"],
    ["payments", "eu-central-1", "1.30", "ACTIVE"],
  ],
  "345678901234": [
    ["staging", "eu-west-1", "1.32", "ACTIVE"],
    ["preview-envs", "eu-west-1", "1.32", "UPDATING"],
  ],
  "456789012345": [["sandbox", "eu-central-1", "1.33", "ACTIVE"]],
  "567890123456": [
    ["analytics", "us-west-2", "1.31", "ACTIVE"],
    ["airflow", "us-west-2", "1.30", "ACTIVE"],
  ],
  "678901234567": [],
  "789012345678": [["tooling", "eu-west-1", "1.31", "ACTIVE"]],
};

const REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1",
  "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
  "me-central-1", "af-south-1", "il-central-1",
];
/* What "every enabled region" scans in the harness (kept short). */
const ENABLED = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "eu-north-1", "ap-southeast-2"];

const PROFILES = [
  { name: "default", kind: "static", region: "eu-west-1", ssoSession: null, ssoStartUrl: null, ssoRegion: null, mfa: false },
  { name: "acme-prod-admin", kind: "sso", region: "eu-west-1", ssoSession: "acme", ssoStartUrl: "https://acme.awsapps.com/start", ssoRegion: "eu-west-1", mfa: false },
  { name: "acme-staging", kind: "sso", region: "eu-west-1", ssoSession: "acme", ssoStartUrl: "https://acme.awsapps.com/start", ssoRegion: "eu-west-1", mfa: false },
  { name: "legacy-ops", kind: "assumeRole", region: "us-east-1", ssoSession: null, ssoStartUrl: null, ssoRegion: null, mfa: true },
  { name: "ci-deployer", kind: "credentialProcess", region: "eu-central-1", ssoSession: null, ssoStartUrl: null, ssoRegion: null, mfa: false },
];

const STORE = "harness-cloud";
type State = { connections: Connection[]; catalog: CatalogEntry[]; refreshedAt: number | null };
const load = (): State => JSON.parse(sessionStorage.getItem(STORE) || '{"connections":[],"catalog":[],"refreshedAt":null}');
const save = (state: State) => sessionStorage.setItem(STORE, JSON.stringify(state));

const err = (code: string, message: string) => ({ code, message, field: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const accountName = (id: string) => ACCOUNTS.find((a) => a.accountId === id)?.accountName ?? null;
const endpointOf = (name: string, region: string) =>
  `https://${(name.length * 7919).toString(16).toUpperCase().padStart(8, "B")}9E1C${name.length}D.gr7.${region}.eks.amazonaws.com`;
const portalName = (url: string) => new URL(url).hostname.replace(/\.awsapps\.com$/, "");

const entry = (connection: Connection, accountId: string, roleName: string | null, [name, region, version, status]: [string, string, string, string]): CatalogEntry => ({
  key: `aws:${connection.id}:${accountId}:${region}:${name}`,
  provider: "aws",
  connectionId: connection.id,
  accountId,
  accountName: accountName(accountId),
  roleName,
  region,
  name,
  version,
  status,
  endpoint: endpointOf(name, region),
  createdAt: Date.now() - 200 * 86400_000,
  state: "available",
  addedContext: null,
});

interface ManagedHooks {
  addEntry: (entry: { context: string; server: string; namespace: string | null; auth: any; origin: string }) => { context: string; kubeConfig: string };
  contextNames: () => Set<string>;
  removeContexts: (contexts: string[]) => void;
}

export function createCloudMocks(scenario: string, send: Send, managed: ManagedHooks) {
  const params = new URLSearchParams(location.search);
  const waitForSso = params.get("ssowait") === "1";

  const PREFIX: Record<string, string> = {
    aws: "eks", gcp: "gke", azure: "aks", digitalocean: "do", linode: "lke", civo: "civo", scaleway: "scw", vultr: "vke", exoscale: "sks",
  };
  const AUTH: Record<string, string> = { gcp: "gke-gcloud-auth-plugin", azure: "kubelogin" };
  const addToKubeconfig = (cluster: CatalogEntry) => {
    const names = managed.contextNames();
    const base = `${PREFIX[cluster.provider] ?? cluster.provider}-${cluster.region.toLowerCase()}-${cluster.name}`;
    let context = base;
    for (let n = 2; names.has(context); n++) context = `${base}-${n}`;
    const added = managed.addEntry({
      context,
      server: cluster.endpoint ?? "",
      namespace: null,
      auth: { kind: "exec", command: AUTH[cluster.provider] ?? "jetpilot-auth", interactive: "nonInteractive" },
      origin: "cloud",
    });
    cluster.state = "added";
    cluster.addedContext = { context: added.context, kubeConfig: MANAGED_KUBECONFIG };
    return cluster.addedContext;
  };

  /* ?scenario=cloud: accounts and a catalog, as after a while of use. */
  if (scenario === "cloud" && !sessionStorage.getItem(STORE)) {
    const now = Date.now();
    const acme: Connection = {
      id: "conn-acme", provider: "aws", kind: "sso", label: "acme", identity: "dev@acme.example",
      sso: { startUrl: "https://acme.awsapps.com/start", region: "eu-west-1" }, profile: null, regions: [],
      targets: ACCOUNTS.slice(0, 4).map((a) => ({ accountId: a.accountId, accountName: a.accountName, roleName: "EKSClusterAdmin" })),
      status: "signedIn", expiresAt: now + 7 * 3600_000, message: null, createdAt: now - 30 * 86400_000,
    };
    acme.targets[2]!.roleName = "AdministratorAccess";
    const ci: Connection = {
      id: "conn-ci", provider: "aws", kind: "keys", label: "platform-ci", identity: "arn:aws:iam::789012345678:user/platform-ci",
      sso: null, profile: null, regions: ["eu-west-1"], targets: [], status: "signedIn", expiresAt: null, message: null,
      createdAt: now - 12 * 86400_000,
    };
    const contoso: Connection = {
      id: "conn-contoso", provider: "aws", kind: "sso", label: "contoso (client)", identity: "dev@contoso.example",
      sso: { startUrl: "https://contoso.awsapps.com/start", region: "us-east-1" }, profile: null, regions: ["us-east-1", "us-west-2"],
      targets: [{ accountId: "112233445566", accountName: "contoso-platform", roleName: "ReadOnlyAccess" }],
      status: "expired", expiresAt: now - 3 * 3600_000, message: "The IAM Identity Center session ended. Sign in again.",
      createdAt: now - 60 * 86400_000,
    };
    const state: State = { connections: [acme, ci, contoso], catalog: [], refreshedAt: now - 6 * 60_000 };
    for (const target of acme.targets) {
      for (const spec of CLUSTERS[target.accountId] ?? []) state.catalog.push(entry(acme, target.accountId, target.roleName, spec));
    }
    state.catalog.push(entry(ci, "789012345678", null, CLUSTERS["789012345678"]![0]!));
    state.catalog.push({
      ...entry(contoso, "112233445566", "ReadOnlyAccess", ["platform", "us-east-1", "1.30", "ACTIVE"]),
      accountName: "contoso-platform",
    });
    const legacy = entry(acme, "210987654321", "EKSClusterAdmin", ["legacy-eu", "eu-west-1", "1.28", "ACTIVE"]);
    state.catalog.push(legacy);
    for (const cluster of state.catalog) {
      if (["prod-eu", "prod-us", "payments", "staging", "tooling", "platform", "legacy-eu"].includes(cluster.name)) {
        addToKubeconfig(cluster);
      }
    }
    legacy.state = "removed";
    state.catalog.find((c) => c.name === "airflow")!.state = "ignored";
    save(state);
  }

  /* ?scenario=clouds: an account in several clouds. */
  if (scenario === "clouds" && !sessionStorage.getItem(STORE)) {
    const now = Date.now();
    const state: State = { connections: [], catalog: [], refreshedAt: now - 4 * 60_000 };
    const acme: Connection = {
      id: "conn-acme", provider: "aws", kind: "sso", label: "acme", identity: "dev@acme.example",
      sso: { startUrl: "https://acme.awsapps.com/start", region: "eu-west-1" }, profile: null, regions: [],
      targets: ACCOUNTS.slice(0, 2).map((a) => ({ accountId: a.accountId, accountName: a.accountName, roleName: "EKSClusterAdmin" })),
      status: "signedIn", expiresAt: now + 6 * 3600_000, message: null, createdAt: now - 30 * 86400_000,
    };
    state.connections.push(acme);
    for (const target of acme.targets) {
      for (const spec of CLUSTERS[target.accountId] ?? []) state.catalog.push(entry(acme, target.accountId, target.roleName, spec));
    }
    for (const seed of OTHER_CLOUDS.scenario(now)) {
      state.connections.push(seed.connection as Connection);
      state.catalog.push(...(seed.clusters as CatalogEntry[]));
    }
    for (const cluster of state.catalog) {
      if (["prod-eu", "payments", "checkout", "web", "aks-weu-core", "hobby", "sks-prod"].includes(cluster.name)) addToKubeconfig(cluster);
    }
    save(state);
  }

  /* Sign-in sessions (device code). */
  const sessions = new Map<string, { timers: ReturnType<typeof setTimeout>[]; finish: () => void }>();
  let sessionIds = 0;

  const signIn = (connectionId: string, channel: Channel) => {
    const state = load();
    const connection = state.connections.find((c) => c.id === connectionId);
    if (!connection) throw err("notFound", "This account was removed.");
    const id = `aws-sso-${++sessionIds}`;
    const region = connection.sso?.region ?? "eu-west-1";
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = () => {
      timers.forEach(clearTimeout);
      sessions.delete(id);
      const latest = load();
      const target = latest.connections.find((c) => c.id === connectionId);
      if (target) {
        Object.assign(target, { status: "signedIn", expiresAt: Date.now() + 8 * 3600_000, message: null, identity: target.identity ?? `dev@${portalName(target.sso?.startUrl ?? "https://acme.awsapps.com")}.example` });
        save(latest);
      }
      send(channel, { type: "succeeded", expiresAt: Date.now() + 8 * 3600_000 });
    };
    timers.push(
      setTimeout(() => {
        send(channel, { type: "started", command: "IAM Identity Center" });
        send(channel, {
          type: "deviceCode",
          userCode: "QXRW-PLMK",
          verificationUri: `https://device.sso.${region}.amazonaws.com/`,
          verificationUriComplete: `https://device.sso.${region}.amazonaws.com/?user_code=QXRW-PLMK`,
        });
      }, 350)
    );
    if (!waitForSso) timers.push(setTimeout(finish, 3800));
    sessions.set(id, { timers, finish });
    return id;
  };
  (window as any).__harnessFinishSso = () => {
    [...sessions.values()].forEach((s) => s.finish());
    OTHER_CLOUDS.finishAll();
  };

  /* Credential status of clusters added from an account: the account's sign-in. */
  (window as any).__harnessCloudCredential = (context: string) => {
    const state = load();
    const cluster = state.catalog.find((c) => c.addedContext?.context === context);
    const connection = cluster && state.connections.find((c) => c.id === cluster.connectionId);
    if (!connection) return null;
    const signInLabel =
      connection.kind === "sso"
        ? `Sign in to AWS (${connection.label})`
        : connection.kind === "cli" && connection.provider !== "digitalocean"
          ? `Sign in with ${connection.provider === "gcp" ? "gcloud" : "az"}`
          : null;
    if (connection.status !== "signedIn") return { state: "expired", expiresAt: connection.expiresAt, signInLabel };
    return { state: "valid", expiresAt: connection.expiresAt, signInLabel };
  };

  /* Discovery: one scope per account and region, clusters as each account finishes. */
  const refresh = async (ids: string[] | null, channel: Channel) => {
    const state = load();
    const targets = state.connections.filter((c) => (!ids || ids.includes(c.id)) && c.status === "signedIn");
    send(channel, { type: "progress", connectionId: targets[0]?.id ?? "", scope: "regions", state: "running" });
    await sleep(250);
    send(channel, { type: "progress", connectionId: targets[0]?.id ?? "", scope: "regions", state: "done" });
    for (const connection of targets) {
      if (connection.provider !== "aws") {
        const found = await OTHER_CLOUDS.discover(connection as never, (message) => send(channel, message), state.catalog as never);
        state.catalog = [...state.catalog.filter((c) => !found.some((f) => f.key === c.key)), ...(found as CatalogEntry[])];
        continue;
      }
      const accounts =
        connection.kind === "sso"
          ? connection.targets
          : [{ accountId: connection.kind === "keys" ? "789012345678" : "210987654321", accountName: null, roleName: null as unknown as string }];
      const regions = connection.regions.length ? connection.regions : ENABLED;
      for (const account of accounts) {
        const name = account.accountName ?? accountName(account.accountId) ?? account.accountId;
        for (const region of regions) {
          const scope = `${name} · ${region}`;
          send(channel, { type: "progress", connectionId: connection.id, scope, accountId: account.accountId, accountName: name, region, state: "running" });
          await sleep(55);
          const denied = account.accountId === "678901234567";
          send(channel, {
            type: "progress", connectionId: connection.id, scope, accountId: account.accountId, accountName: name, region,
            state: denied ? "error" : "done",
            message: denied ? `AccessDeniedException: ${account.roleName} isn't allowed to perform eks:ListClusters` : null,
          });
        }
        const found = (CLUSTERS[account.accountId] ?? [])
          .filter(([, region]) => regions.includes(region))
          .map((spec) => {
            const fresh = entry(connection, account.accountId, account.roleName ?? null, spec);
            const known = state.catalog.find((c) => c.key === fresh.key);
            return known ? { ...fresh, state: known.state, addedContext: known.addedContext } : fresh;
          });
        state.catalog = [...state.catalog.filter((c) => !found.some((f) => f.key === c.key)), ...found];
        send(channel, { type: "clusters", connectionId: connection.id, clusters: found });
      }
    }
    state.refreshedAt = Date.now();
    save(state);
    send(channel, { type: "done", refreshedAt: state.refreshedAt });
  };

  const handlers: Record<string, (p: any) => unknown> = {
    connections_list: () =>
      load().connections.map((c) =>
        c.kind === "cli"
          ? OTHER_CLOUDS.isSignedIn(c.provider as OtherProvider)
            ? { ...c, status: "signedIn", message: null }
            : { ...c, status: "signedOut", message: c.message ?? `Sign in with ${c.provider === "gcp" ? "gcloud" : "az"} again.` }
          : c
      ),
    connection_create: async (p) => {
      await sleep(350);
      const spec = p.spec;
      const state = load();
      const base = {
        id: `conn-${Math.random().toString(36).slice(2, 10)}`, provider: "aws" as const, identity: null, sso: null, profile: null,
        regions: [], targets: [], expiresAt: null, message: null, createdAt: Date.now(),
      };
      let connection: Connection;
      if (spec.kind === "cli" || spec.kind === "token" || spec.kind === "apiKey") {
        connection = { ...base, ...(OTHER_CLOUDS.create(spec) as Partial<Connection>) } as Connection;
      } else if (spec.kind === "sso") {
        connection = { ...base, kind: "sso", label: spec.label || portalName(spec.startUrl), sso: { startUrl: spec.startUrl, region: spec.region }, status: "signedOut" };
      } else if (spec.kind === "profile") {
        const profile = PROFILES.find((pr) => pr.name === spec.profile);
        if (!profile) throw err("notFound", `There's no profile ${spec.profile} in ~/.aws/config.`);
        connection = profile.mfa
          ? {
              ...base, kind: "profile", label: spec.label || profile.name, profile: profile.name,
              status: "signedOut", message: "Enter an MFA code to use this profile",
            }
          : {
              ...base, kind: "profile", label: spec.label || profile.name, profile: profile.name,
              identity: `arn:aws:sts::210987654321:assumed-role/${profile.kind === "sso" ? "AWSReservedSSO_AdministratorAccess" : "OpsAdmin"}/dev`,
              status: "signedIn", expiresAt: Date.now() + 5 * 3600_000,
            };
      } else {
        if (String(spec.accessKeyId).includes("BAD")) {
          throw err("invalidInput", "AWS didn't accept these keys: The security token included in the request is invalid.");
        }
        connection = {
          ...base, kind: "keys", label: spec.label || "access keys", identity: "arn:aws:iam::789012345678:user/platform-ci",
          status: "signedIn", regions: [],
        };
      }
      state.connections.push(connection);
      save(state);
      return connection;
    },
    connection_update: (p) => {
      const state = load();
      const connection = state.connections.find((c) => c.id === p.id);
      if (!connection) throw err("notFound", "This account was removed.");
      Object.assign(connection, Object.fromEntries(Object.entries(p.patch).filter(([, v]) => v !== undefined)));
      save(state);
      return connection;
    },
    connection_delete: (p) => {
      const state = load();
      const own = state.catalog.filter((c) => c.connectionId === p.id);
      if (p.removeClusters) managed.removeContexts(own.flatMap((c) => (c.addedContext ? [c.addedContext.context] : [])));
      state.connections = state.connections.filter((c) => c.id !== p.id);
      state.catalog = state.catalog.filter((c) => c.connectionId !== p.id);
      save(state);
    },
    aws_sso_sign_in: (p) => signIn(p.connectionId, p.onEvent),
    aws_mfa_sign_in: async (p) => {
      await sleep(500);
      if (p.code === "000000") throw { code: "invalidInput", message: "AWS didn't accept that code. Wait for the next one and try again.", field: "code" };
      const state = load();
      const connection = state.connections.find((c) => c.id === p.connectionId)!;
      Object.assign(connection, {
        status: "signedIn", message: null, expiresAt: Date.now() + 3600_000,
        identity: "arn:aws:sts::210987654321:assumed-role/OpsAdmin/legacy-ops",
      });
      save(state);
      return connection;
    },
    aws_sso_accounts: async () => {
      await sleep(600);
      return ACCOUNTS;
    },
    aws_profiles_list: () => PROFILES,
    aws_regions: () => REGIONS,
    catalog_get: () => {
      const state = load();
      return { clusters: state.catalog, refreshedAt: state.refreshedAt };
    },
    catalog_refresh: (p) => refresh(p.connectionIds ?? null, p.onEvent),
    cloud_cli_status: async (p) => {
      await sleep(300);
      return OTHER_CLOUDS.cliStatus(p.provider as OtherProvider);
    },
    cloud_cli_sign_in: (p) => OTHER_CLOUDS.cliSignIn(p.provider as OtherProvider, (message) => send(p.onEvent, message), waitForSso),
    connection_scopes: async (p) => {
      await sleep(500);
      const connection = load().connections.find((c) => c.id === p.connectionId);
      return OTHER_CLOUDS.scopes(connection?.provider as OtherProvider);
    },
    provider_regions: (p) => (p.provider === "aws" ? REGIONS : OTHER_CLOUDS.regions(p.provider as OtherProvider)),
    catalog_set_state: (p) => {
      const state = load();
      for (const cluster of state.catalog) if (p.keys.includes(cluster.key)) cluster.state = p.state;
      save(state);
    },
    catalog_add: async (p) => {
      await sleep(400);
      const state = load();
      const added = [];
      for (const key of p.keys as string[]) {
        const cluster = state.catalog.find((c) => c.key === key);
        if (cluster && cluster.state !== "added") added.push(addToKubeconfig(cluster));
      }
      save(state);
      const warnings = OTHER_CLOUDS.pluginMissing()
        ? state.catalog
            .filter((c) => p.keys.includes(c.key) && (c.provider === "gcp" || c.provider === "azure"))
            .map((c) => ({
              key: c.key,
              message:
                c.provider === "gcp"
                  ? "gke-gcloud-auth-plugin isn't installed: install it with `gcloud components install gke-gcloud-auth-plugin`."
                  : "kubelogin isn't installed: JET Pilot can download it in Settings › Advanced.",
            }))
        : [];
      return { added, failed: [], warnings };
    },
  };

  return {
    handlers,
    /* Probe results for clusters added from the catalog (version, gone ones unreachable). */
    status: (context: string) => {
      const cluster = load().catalog.find((c) => c.addedContext?.context === context);
      if (!cluster) return null;
      if (cluster.state === "removed") return { reachability: "unreachable", message: "Couldn't resolve the API server host" };
      const suffix = { aws: "-eks-2d5f260", gcp: "-gke.1415000" }[cluster.provider] ?? "";
      return { reachability: "reachable", serverVersion: `v${cluster.version}.4${suffix}`, nodeCount: 3 + (cluster.name.length % 9) };
    },
  };
}
