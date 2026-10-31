/*
 * The kubeconfig files contexts are loaded from: the files the user added
 * (Settings › Clusters) followed by the ones found automatically
 * (~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml, ~/.kube/config.d) when
 * `kubeconfig.autoDetect` is on. Without any, ~/.kube/config.
 */
import { shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { warn } from "@/lib/logger";
import type { Settings } from "@/lib/settings/types";

export type KubeconfigOrigin = "managed" | "default" | "env" | "directory" | "configD";

/** `kubeconfig_discover` (src-tauri). */
export interface DiscoveredKubeconfig {
  path: string;
  origin: KubeconfigOrigin;
  readable: boolean;
  error?: string | null;
  contextCount: number;
  contextNames: string[];
}

export const ORIGIN_LABELS: Record<KubeconfigOrigin, string> = {
  managed: "Added in JET Pilot",
  default: "Default",
  env: "$KUBECONFIG",
  directory: "~/.kube",
  configD: "config.d",
};

/** The last discovery result (null until the first one finished). */
export const discoveredKubeconfigs = shallowRef<DiscoveredKubeconfig[] | null>(null);

let home: Promise<string> | null = null;
/** The home directory ("" when unknown). */
export const homePath = () => (home ??= homeDir().catch(() => ""));

export const normalizeKubeconfigPath = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "");

/** `~/x` → `<home>/x` (paths typed by hand). */
export async function expandHome(path: string): Promise<string> {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const dir = await homePath();
  return dir ? `${dir}${path.slice(1)}` : path;
}

async function defaultKubeconfig(): Promise<string> {
  const dir = await homePath();
  return dir ? `${dir}/.kube/config` : "";
}

let pending: Promise<DiscoveredKubeconfig[]> | null = null;
let again = false;

const discoverOnce = () =>
  invoke<DiscoveredKubeconfig[] | null>("kubeconfig_discover")
    .then((found) => found ?? [])
    .catch(async (e) => {
      warn(`Kubeconfig discovery failed, using ~/.kube/config: ${e}`);
      const path = await defaultKubeconfig();
      return path
        ? [{ path, origin: "default" as const, readable: true, contextCount: 0, contextNames: [] }]
        : [];
    });

/**
 * Finds kubeconfig files (cached; `force` looks again). A forced look while
 * one runs looks once more afterwards: the running one may predate the
 * change it's asked for.
 */
export function discoverKubeconfigs(force = false): Promise<DiscoveredKubeconfig[]> {
  if (!force && discoveredKubeconfigs.value) {
    return Promise.resolve(discoveredKubeconfigs.value);
  }
  if (pending) {
    if (force) again = true;
    return pending;
  }
  pending = (async () => {
    let found: DiscoveredKubeconfig[];
    do {
      again = false;
      found = await discoverOnce();
    } while (again);
    discoveredKubeconfigs.value = found;
    return found;
  })().finally(() => (pending = null));
  return pending;
}

/**
 * Kubeconfig paths in order: added files, then readable detected ones.
 * Duplicates (the same file added and detected) are listed once. Without
 * auto-detection only JET Pilot's own kubeconfig (clusters added in the
 * app) is taken from `detected`, and ~/.kube/config stands in when the user
 * has no files of their own.
 */
export function mergeKubeconfigPaths(
  sources: readonly string[],
  detected: readonly DiscoveredKubeconfig[] | null,
  fallback: string,
  autoDetect = true
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string) => {
    const trimmed = path.trim();
    const key = normalizeKubeconfigPath(trimmed);
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    paths.push(trimmed);
  };
  sources.forEach(add);
  const managed = new Set<string>();
  for (const file of detected ?? []) {
    if (!file.readable || (!autoDetect && file.origin !== "managed")) continue;
    if (file.origin === "managed") managed.add(normalizeKubeconfigPath(file.path.trim()));
    add(file.path);
  }
  const ownFiles = paths.filter((path) => !managed.has(normalizeKubeconfigPath(path.trim())));
  if (fallback && ownFiles.length === 0 && (!autoDetect || paths.length === 0)) add(fallback);
  return paths;
}

/**
 * The kubeconfig files to load contexts from, for the current settings.
 * Clusters added in JET Pilot are always included: auto-detection is about
 * the user's other kubeconfig files.
 */
export async function resolveKubeconfigPaths(settings: Settings): Promise<string[]> {
  const { sources, autoDetect } = settings.kubeconfig;
  const [expanded, detected, fallback] = await Promise.all([
    Promise.all(sources.map(expandHome)),
    discoverKubeconfigs(),
    defaultKubeconfig(),
  ]);
  return mergeKubeconfigPaths(expanded, detected, fallback, autoDetect);
}

/** Whether `path` is JET Pilot's own kubeconfig (as found by discovery). */
export function isManagedKubeconfig(path: string): boolean {
  const key = normalizeKubeconfigPath(path.trim());
  return !!discoveredKubeconfigs.value?.some(
    (file) => file.origin === "managed" && normalizeKubeconfigPath(file.path.trim()) === key
  );
}

/* --------------------------------------------- kubeconfig_describe -- */

export type AuthKind = "token" | "clientCert" | "exec" | "authProvider" | "basic" | "none";

export interface KubeconfigProblem {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface KubeconfigContextSummary {
  name: string;
  cluster: string;
  server?: string | null;
  user: string;
  namespace?: string | null;
  auth: {
    kind: AuthKind;
    command?: string | null;
    awsProfile?: string | null;
    /** Whether signing in may need the user (src-tauri/src/auth/classify.rs). */
    interactive?: "nonInteractive" | "interactive" | "unknown";
  };
  problems: KubeconfigProblem[];
}

/** `kubeconfig_describe` (src-tauri): contexts with their auth type and problems, no secrets. */
export interface KubeconfigReport {
  path: string;
  currentContext?: string | null;
  contexts: KubeconfigContextSummary[];
}

export function describeKubeconfig(path: string): Promise<KubeconfigReport> {
  return invoke<KubeconfigReport>("kubeconfig_describe", { path });
}

export const AUTH_LABELS: Record<AuthKind, string> = {
  token: "Token",
  clientCert: "Client certificate",
  exec: "Exec plugin",
  authProvider: "Auth provider",
  basic: "Username & password",
  none: "No credentials",
};
