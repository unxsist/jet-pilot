/*
 * Every context JET Pilot knows about: the contexts of all kubeconfig
 * sources (added + detected, src/lib/kubeconfigSources.ts) with their API
 * server, sign-in method and the provider they run on. Shared by the
 * Clusters hub and the context switcher; loaded lazily.
 */
import { shallowRef } from "vue";
import { contextKey } from "@/lib/contextKey";
import { Kubernetes } from "@/services/Kubernetes";
import { warn } from "@/lib/logger";
import type { Settings } from "@/lib/settings/types";
import {
  describeKubeconfig,
  discoveredKubeconfigs,
  normalizeKubeconfigPath,
  resolveKubeconfigPaths,
  type AuthKind,
  type KubeconfigOrigin,
  type KubeconfigProblem,
} from "@/lib/kubeconfigSources";
import { detectProvider, type ProviderInfo } from "./provider";

export type InteractiveClass = "nonInteractive" | "interactive" | "unknown";

export interface InventoryEntry {
  key: string;
  context: string;
  kubeConfig: string;
  cluster: string;
  user: string;
  namespace?: string | null;
  server?: string | null;
  auth: {
    kind: AuthKind;
    command?: string | null;
    awsProfile?: string | null;
    /** Whether signing in may need the user (browser, device code). */
    interactive?: InteractiveClass;
  };
  problems: KubeconfigProblem[];
  provider: ProviderInfo;
  /** Where the kubeconfig came from: added by the user, or found. */
  origin: "added" | KubeconfigOrigin | "fallback";
  current: boolean;
}

export interface InventoryFileError {
  path: string;
  message: string;
}

export const inventory = shallowRef<InventoryEntry[] | null>(null);
export const inventoryErrors = shallowRef<InventoryFileError[]>([]);

const originOf = (path: string, settings: Settings): InventoryEntry["origin"] => {
  const key = normalizeKubeconfigPath(path);
  if (settings.kubeconfig.sources.some((source) => normalizeKubeconfigPath(source) === key)) return "added";
  const found = discoveredKubeconfigs.value?.find((file) => normalizeKubeconfigPath(file.path) === key);
  return found?.origin ?? "fallback";
};

const errorText = (e: unknown) => (e as { message?: string })?.message ?? String(e);

async function entriesOf(path: string, settings: Settings): Promise<InventoryEntry[]> {
  const origin = originOf(path, settings);
  try {
    const report = await describeKubeconfig(path);
    return report.contexts.map((context) => ({
      key: contextKey(context.name, path),
      context: context.name,
      kubeConfig: path,
      cluster: context.cluster,
      user: context.user,
      namespace: context.namespace,
      server: context.server,
      auth: context.auth,
      problems: context.problems,
      provider: detectProvider({
        context: context.name,
        cluster: context.cluster,
        server: context.server,
        authCommand: context.auth.command,
      }),
      origin,
      current: report.currentContext === context.name,
    }));
  } catch (describeError) {
    // Fall back to the plain context list (no server / auth details).
    const contexts = await Kubernetes.getContexts(path).catch(() => {
      throw describeError;
    });
    return contexts.map((context) => ({
      key: contextKey(context.name, path),
      context: context.name,
      kubeConfig: path,
      cluster: "",
      user: "",
      namespace: context.context?.namespace,
      auth: { kind: "none" as const },
      problems: [],
      provider: detectProvider({ context: context.name }),
      origin,
      current: false,
    }));
  }
}

let pending: Promise<InventoryEntry[]> | null = null;

/** (Re)reads every kubeconfig source. Concurrent calls share one read. */
export function loadInventory(settings: Settings): Promise<InventoryEntry[]> {
  pending ??= (async () => {
    const paths = await resolveKubeconfigPaths(settings);
    const errors: InventoryFileError[] = [];
    const lists = await Promise.all(
      paths.map((path) =>
        entriesOf(path, settings).catch((e) => {
          warn(`Failed to read the contexts of ${path}: ${errorText(e)}`);
          errors.push({ path, message: errorText(e) });
          return [] as InventoryEntry[];
        })
      )
    );
    const entries = lists.flat();
    inventory.value = entries;
    inventoryErrors.value = errors;
    return entries;
  })().finally(() => (pending = null));
  return pending;
}
