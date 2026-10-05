/*
 * Clusters added in JET Pilot (src-tauri/src/clusters): the app-managed
 * kubeconfig (~/.kube/jet-pilot/config), importing and entering clusters,
 * exports, and the vault that keeps their credentials (OS keychain, or an
 * encrypted file unlocked with a passphrase).
 */
import { invoke } from "@tauri-apps/api/core";
import { shallowRef } from "vue";
import type { AuthKind, KubeconfigProblem } from "@/lib/kubeconfigSources";
import type { ContextRef } from "@/lib/contextKey";

export type AppErrorCode =
  | "vaultLocked"
  | "keychainUnavailable"
  | "invalidInput"
  | "conflict"
  | "notFound"
  | "io"
  | "internal";

export interface AppError {
  code: AppErrorCode;
  message: string;
  field?: string | null;
}

export const isAppError = (e: unknown): e is AppError =>
  !!e && typeof e === "object" && typeof (e as AppError).code === "string" && typeof (e as AppError).message === "string";

export const errorMessage = (e: unknown) =>
  isAppError(e) ? e.message : (e as { message?: string })?.message ?? String(e);

/* ------------------------------------------------------------ import -- */

export type ImportSource = { kind: "text"; text: string } | { kind: "path"; path: string };

export interface ImportContext {
  name: string;
  cluster: string;
  server?: string | null;
  user: string;
  namespace?: string | null;
  auth: { kind: AuthKind; command?: string | null; awsProfile?: string | null; interactive?: string };
  problems: KubeconfigProblem[];
  /** Already available (same server and credentials). */
  duplicateOf?: ContextRef | null;
  nameConflict: boolean;
  suggestedName: string;
  /** The command an exec plugin runs (shown before importing it). */
  execCommand?: { command: string; args: string[] } | null;
}

export interface ImportPreview {
  previewId: string;
  contexts: ImportContext[];
}

export interface ImportChoice {
  context: string;
  include: boolean;
  rename?: string | null;
}

export const previewImport = (source: ImportSource) =>
  invoke<ImportPreview>("kubeconfig_import_preview", { source });

export const commitImport = (previewId: string, choices: ImportChoice[]) =>
  invoke<{ added: ContextRef[] }>("kubeconfig_import_commit", { previewId, choices });

/* ------------------------------------------------------------ manual -- */

export type CaSpec =
  | { kind: "system" }
  | { kind: "pem"; pem: string }
  | { kind: "file"; path: string }
  | { kind: "insecure" };

export type ManualAuth =
  | { kind: "token"; token: string }
  | { kind: "clientCert"; certPem: string; keyPem: string }
  | { kind: "none" };

export interface ManualClusterSpec {
  name: string;
  server: string;
  ca: CaSpec;
  auth: ManualAuth;
  namespace?: string | null;
}

export const addManualCluster = (spec: ManualClusterSpec) =>
  invoke<ContextRef>("cluster_add_manual", { spec });

export const testConnection = (spec: ManualClusterSpec) =>
  invoke<{ ok: boolean; serverVersion?: string | null; message?: string | null }>("cluster_test_connection", { spec });

/* ----------------------------------------------------------- managed -- */

export interface ManagedCluster {
  context: string;
  clusterId: string;
  origin: string;
  addedAt: number;
  server?: string | null;
}

export const managedList = () => invoke<ManagedCluster[]>("managed_list");
export const removeManaged = (contexts: string[], forgetSecrets = true) =>
  invoke<void>("managed_remove", { contexts, forgetSecrets });
export const renameManaged = (context: string, newName: string) =>
  invoke<string>("managed_rename", { context, newName });
export const exportManaged = (contexts: string[], mode: "helper" | "inline", dest: string) =>
  invoke<{ written: number }>("managed_export", { contexts, mode, dest });
export const exportToKubeConfig = (contexts: string[]) =>
  invoke<{ written: number; skipped: string[]; backup: string }>("managed_export_to_kube_config", { contexts });

export interface ClustersPaths {
  home: string;
  kubeconfig: string;
  bin: string;
  helper: string;
}
export const clustersPaths = () => invoke<ClustersPaths>("clusters_paths");

export interface HelperStatus {
  installed: boolean;
  path: string;
  version?: string | null;
  bundledVersion?: string | null;
}
export const helperStatus = () => invoke<HelperStatus>("helper_status");
export const reinstallHelper = () => invoke<HelperStatus>("helper_reinstall");

/* ------------------------------------------------------------- vault -- */

export interface VaultStatus {
  backend: "keychain" | "passphrase" | "none";
  initialized: boolean;
  locked: boolean;
  keychainAvailable: boolean;
  keychainProblem?: string | null;
  unlockCached?: boolean;
}

export const vaultStatus = () => invoke<VaultStatus>("vault_status");
export const initPassphrase = (passphrase: string) => invoke<void>("vault_init_passphrase", { passphrase });
export const unlockVault = (passphrase: string, cacheForTerminals: boolean) =>
  invoke<void>("vault_unlock", { passphrase, cacheForTerminals });
export const lockVault = () => invoke<void>("vault_lock");
export const changePassphrase = (old: string, next: string) =>
  invoke<void>("vault_change_passphrase", { old, new: next });
export const resetVault = () => invoke<void>("vault_reset", { confirm: "reset" });

/*
 * Operations that store credentials ask for the vault passphrase when there
 * is no keychain (or the vault is locked) and retry once.
 */
export type VaultPrompt = { mode: "setup" | "unlock"; problem?: string | null; resolve: (ok: boolean) => void };
export const vaultPrompt = shallowRef<VaultPrompt | null>(null);

const askVault = (mode: VaultPrompt["mode"], problem?: string | null) =>
  new Promise<boolean>((resolve) => {
    vaultPrompt.value?.resolve(false);
    vaultPrompt.value = { mode, problem, resolve };
  });

/** Asks for the passphrase to unlock the vault (Settings › Advanced). */
export const promptUnlock = () => askVault("unlock");

export async function withVault<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    if (!isAppError(e) || (e.code !== "vaultLocked" && e.code !== "keychainUnavailable")) throw e;
    const status = await vaultStatus().catch(() => null);
    const mode = status?.initialized ? "unlock" : "setup";
    if (!(await askVault(mode, status?.keychainProblem))) throw e;
    return operation();
  }
}

/* --------------------------------------------------------- the dialog -- */

export type AddMethod = "choose" | "paste" | "file" | "manual";

/** The add-cluster dialog (AddClusterHost renders it). */
export const addClusterRequest = shallowRef<{ method: AddMethod; id: number } | null>(null);
let requests = 0;
export function openAddCluster(method: AddMethod = "choose") {
  addClusterRequest.value = { method, id: ++requests };
}
