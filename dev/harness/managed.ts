/*
 * Clusters added in JET Pilot (src-tauri/src/clusters): the managed
 * kubeconfig, imports, manual clusters, exports and the vault. State lives
 * in sessionStorage so a reload keeps added clusters.
 *
 * ?scenario=no-keychain: no system keychain; storing credentials asks for a
 * passphrase first.
 */
import yaml from "js-yaml";
import { HOME } from "./fixtures";

export const MANAGED_KUBECONFIG = `${HOME}/.kube/jet-pilot/config`;
const PICKED_KUBECONFIG = `${HOME}/Downloads/config.yaml`;

interface ManagedEntry {
  context: string;
  clusterId: string;
  server: string;
  namespace: string | null;
  auth: { kind: string; command?: string | null; awsProfile?: string | null; interactive: string };
  origin: string;
  addedAt: number;
}

const STORE = "harness-managed";
const load = (): ManagedEntry[] => JSON.parse(sessionStorage.getItem(STORE) || "[]");
const store = (entries: ManagedEntry[]) => sessionStorage.setItem(STORE, JSON.stringify(entries));

/* The file the import dialog picks: a token cluster, an EKS cluster and one that's already there. */
const PICKED_TEXT = `apiVersion: v1
kind: Config
clusters:
- name: homelab
  cluster: { server: "https://192.168.1.20:6443", certificate-authority-data: "LS0t" }
- name: sandbox
  cluster: { server: "https://7C2D9E11.gr7.eu-central-1.eks.amazonaws.com" }
- name: staging
  cluster: { server: "https://staging.k8s.example.com:6443" }
users:
- name: homelab-admin
  user: { token: "redacted" }
- name: sandbox
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [--region, eu-central-1, eks, get-token, --cluster-name, sandbox]
      env: [{ name: AWS_PROFILE, value: sandbox }]
- name: staging-oidc
  user: { exec: { command: kubelogin, args: [get-token] } }
contexts:
- name: homelab
  context: { cluster: homelab, user: homelab-admin, namespace: default }
- name: eks-sandbox
  context: { cluster: sandbox, user: sandbox }
- name: staging-us-east-2
  context: { cluster: staging, user: staging-oidc }
`;

type Doc = {
  clusters?: { name: string; cluster?: { server?: string } }[];
  users?: { name: string; user?: Record<string, any> }[];
  contexts?: { name: string; context?: { cluster?: string; user?: string; namespace?: string } }[];
};

const previews = new Map<string, ManagedEntry[] & { importContexts?: unknown }>();
let previewIds = 0;

const authOf = (user: Record<string, any> | undefined) => {
  if (user?.exec) {
    const command = String(user.exec.command ?? "").split("/").pop() ?? "";
    const env = (user.exec.env ?? []) as { name: string; value: string }[];
    return {
      kind: "exec",
      command,
      awsProfile: env.find((e) => e.name === "AWS_PROFILE")?.value ?? null,
      interactive: command === "kubelogin" && !(user.exec.args ?? []).includes("-l") ? "interactive" : "nonInteractive",
      args: (user.exec.args ?? []) as string[],
    };
  }
  if (user?.token || user?.tokenFile) return { kind: "token", interactive: "nonInteractive" };
  if (user?.["client-certificate-data"] || user?.["client-certificate"]) return { kind: "clientCert", interactive: "nonInteractive" };
  return { kind: "none", interactive: "nonInteractive" };
};

const err = (code: string, message: string, field?: string) => ({ code, message, field: field ?? null });

export function createManagedMocks(scenario: string, knownContexts: () => string[]) {
  const vault = {
    backend: scenario === "no-keychain" ? "none" : "keychain",
    initialized: scenario !== "no-keychain",
    locked: false,
    passphrase: "",
  };
  const keychainProblem =
    "No Secret Service provider is running on this computer (for example gnome-keyring or KeePassXC).";
  const needsVault = () => {
    if (vault.backend === "none") throw err("keychainUnavailable", "There's no system keychain to store credentials in.");
    if (vault.locked) throw err("vaultLocked", "The credential vault is locked.");
  };

  const contextNames = () => new Set([...knownContexts(), ...load().map((e) => e.context)]);

  const preview = (source: { kind: string; text?: string; path?: string }) => {
    const text = source.kind === "path" ? (source.path === PICKED_KUBECONFIG ? PICKED_TEXT : null) : source.text;
    if (!text) throw err("notFound", `Can't read ${source.path}`);
    let doc: Doc;
    try {
      doc = yaml.load(text) as Doc;
    } catch (e) {
      throw err("invalidInput", `Not a valid kubeconfig: ${(e as Error).message.split("\n")[0]}`);
    }
    if (!doc || !Array.isArray(doc.contexts)) throw err("invalidInput", "Not a kubeconfig: no contexts.");
    const names = contextNames();
    const contexts = doc.contexts.map((ctx) => {
      const cluster = doc.clusters?.find((c) => c.name === ctx.context?.cluster);
      const user = doc.users?.find((u) => u.name === ctx.context?.user);
      const auth = authOf(user?.user);
      const conflict = names.has(ctx.name);
      return {
        name: ctx.name,
        cluster: ctx.context?.cluster ?? "",
        server: cluster?.cluster?.server ?? null,
        user: ctx.context?.user ?? "",
        namespace: ctx.context?.namespace ?? null,
        auth: { kind: auth.kind, command: (auth as any).command ?? null, awsProfile: (auth as any).awsProfile ?? null, interactive: auth.interactive },
        problems: cluster ? [] : [{ code: "clusterMissing", severity: "error", message: `Cluster ${ctx.context?.cluster} isn't defined` }],
        duplicateOf: ctx.name === "staging-us-east-2" ? { context: "staging-us-east-2", kubeConfig: `${HOME}/.kube/config` } : null,
        nameConflict: conflict,
        suggestedName: conflict ? `${ctx.name}-2` : ctx.name,
        execCommand: auth.kind === "exec" ? { command: (auth as any).command, args: (auth as any).args } : null,
      };
    });
    const id = `preview-${++previewIds}`;
    previews.set(id, contexts as never);
    return { previewId: id, contexts };
  };

  const add = (entry: Omit<ManagedEntry, "clusterId" | "addedAt">) => {
    const entries = load();
    entries.push({ ...entry, clusterId: Math.random().toString(36).slice(2, 14), addedAt: Date.now() });
    store(entries);
    return { context: entry.context, kubeConfig: MANAGED_KUBECONFIG };
  };

  const handlers: Record<string, (p: any) => unknown> = {
    clusters_paths: () => ({
      home: `${HOME}/.kube/jet-pilot`,
      kubeconfig: MANAGED_KUBECONFIG,
      bin: `${HOME}/.kube/jet-pilot/bin`,
      helper: `${HOME}/.kube/jet-pilot/bin/jetpilot-auth`,
    }),
    helper_status: () => ({ installed: true, path: `${HOME}/.kube/jet-pilot/bin/jetpilot-auth`, version: "1.42.0", bundledVersion: "1.42.0" }),
    helper_reinstall: () => handlers.helper_status!({}),
    vault_status: () => ({
      backend: vault.backend,
      initialized: vault.initialized,
      locked: vault.locked,
      keychainAvailable: scenario !== "no-keychain",
      keychainProblem: scenario === "no-keychain" ? keychainProblem : null,
      unlockCached: vault.backend === "passphrase" && !vault.locked,
    }),
    vault_init_passphrase: (p) => {
      Object.assign(vault, { backend: "passphrase", initialized: true, locked: false, passphrase: p.passphrase });
    },
    vault_unlock: (p) => {
      if (p.passphrase !== vault.passphrase) throw err("invalidInput", "That passphrase isn't right.");
      vault.locked = false;
    },
    vault_lock: () => {
      vault.locked = true;
    },
    vault_change_passphrase: (p) => {
      if (p.old !== vault.passphrase) throw err("invalidInput", "The current passphrase isn't right.");
      vault.passphrase = p.new;
    },
    vault_reset: () => {
      Object.assign(vault, { backend: scenario === "no-keychain" ? "none" : "keychain", initialized: scenario !== "no-keychain", locked: false });
    },
    kubeconfig_import_preview: (p) => preview(p.source),
    kubeconfig_import_commit: (p) => {
      needsVault();
      const contexts = previews.get(p.previewId) as unknown as ReturnType<typeof preview>["contexts"] | undefined;
      if (!contexts) throw err("notFound", "The preview expired; start again.");
      const added = [];
      for (const choice of p.choices as { context: string; include: boolean; rename?: string | null }[]) {
        if (!choice.include) continue;
        const ctx = contexts.find((c) => c.name === choice.context)!;
        added.push(
          add({
            context: choice.rename || ctx.name,
            server: ctx.server ?? "",
            namespace: ctx.namespace,
            auth: ctx.auth,
            origin: "import",
          })
        );
      }
      return { added };
    },
    cluster_test_connection: async (p) => {
      await new Promise((r) => setTimeout(r, 700));
      return String(p.spec.server).includes("fail")
        ? { ok: false, message: "Timed out after 8 s" }
        : { ok: true, serverVersion: "v1.31.2" };
    },
    cluster_add_manual: (p) => {
      needsVault();
      if (contextNames().has(p.spec.name)) throw err("conflict", `A context called ${p.spec.name} already exists.`, "name");
      return add({
        context: p.spec.name,
        server: p.spec.server,
        namespace: p.spec.namespace ?? null,
        auth: { kind: p.spec.auth.kind, interactive: "nonInteractive" },
        origin: "manual",
      });
    },
    managed_list: () =>
      load().map((e) => ({ context: e.context, clusterId: e.clusterId, origin: e.origin, addedAt: e.addedAt, server: e.server })),
    managed_remove: (p) => {
      store(load().filter((e) => !p.contexts.includes(e.context)));
    },
    managed_rename: (p) => {
      store(load().map((e) => (e.context === p.context ? { ...e, context: p.newName } : e)));
      return p.newName;
    },
    managed_export: (p) => ({ written: p.contexts.length }),
    managed_export_to_kube_config: (p) => ({
      written: p.contexts.length,
      skipped: [],
      backup: `${HOME}/.kube/config.jetpilot-backup-20261005T1912`,
    }),
  };

  return {
    handlers,
    /* kubeconfig_discover entry for the managed file (first, when it has clusters). */
    discovery: () => {
      const entries = load();
      return entries.length
        ? [{ path: MANAGED_KUBECONFIG, origin: "managed", readable: true, contextCount: entries.length, contextNames: entries.map((e) => e.context) }]
        : [];
    },
    describe: (path: string) =>
      path === MANAGED_KUBECONFIG
        ? {
            path,
            currentContext: null,
            contexts: load().map((e) => ({
              name: e.context,
              cluster: `jetpilot-${e.clusterId}`,
              server: e.server,
              user: `jetpilot-${e.clusterId}`,
              namespace: e.namespace,
              auth: { kind: "exec", command: "jetpilot-auth", awsProfile: null, interactive: "nonInteractive", ...(e.auth.kind === "exec" ? e.auth : {}) },
              problems: [],
            })),
          }
        : null,
    contexts: (path: string) =>
      path === MANAGED_KUBECONFIG ? load().map((e) => ({ name: e.context, context: { namespace: e.namespace ?? "default" } })) : null,
  };
}
