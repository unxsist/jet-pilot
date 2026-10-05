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

export type KubeconfigOrigin = "default" | "env" | "directory" | "configD";

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
  default: "Default",
  env: "$KUBECONFIG",
  directory: "~/.kube",
  configD: "config.d",
};

/** The last discovery result (null until the first one finished). */
export const discoveredKubeconfigs = shallowRef<DiscoveredKubeconfig[] | null>(null);

let home: Promise<string> | null = null;
const homePath = () => (home ??= homeDir().catch(() => ""));

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

/** Finds kubeconfig files (cached; `force` looks again). */
export function discoverKubeconfigs(force = false): Promise<DiscoveredKubeconfig[]> {
  if (!force && discoveredKubeconfigs.value) {
    return Promise.resolve(discoveredKubeconfigs.value);
  }
  pending ??= invoke<DiscoveredKubeconfig[] | null>("kubeconfig_discover")
    .then((found) => found ?? [])
    .catch(async (e) => {
      warn(`Kubeconfig discovery failed, using ~/.kube/config: ${e}`);
      const path = await defaultKubeconfig();
      return path
        ? [{ path, origin: "default" as const, readable: true, contextCount: 0, contextNames: [] }]
        : [];
    })
    .then((found) => {
      discoveredKubeconfigs.value = found;
      return found;
    })
    .finally(() => (pending = null));
  return pending;
}

/**
 * Kubeconfig paths in order: added files, then readable detected ones.
 * Duplicates (the same file added and detected) are listed once.
 */
export function mergeKubeconfigPaths(
  sources: readonly string[],
  detected: readonly DiscoveredKubeconfig[] | null,
  fallback: string
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
  for (const file of detected ?? []) {
    if (file.readable) add(file.path);
  }
  if (paths.length === 0 && fallback) add(fallback);
  return paths;
}

/** The kubeconfig files to load contexts from, for the current settings. */
export async function resolveKubeconfigPaths(settings: Settings): Promise<string[]> {
  const { sources, autoDetect } = settings.kubeconfig;
  const [expanded, detected, fallback] = await Promise.all([
    Promise.all(sources.map(expandHome)),
    autoDetect ? discoverKubeconfigs() : Promise.resolve(null),
    defaultKubeconfig(),
  ]);
  return mergeKubeconfigPaths(expanded, detected, fallback);
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
  auth: { kind: AuthKind; command?: string | null; awsProfile?: string | null };
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
