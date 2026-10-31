/*
 * What kubectl uses by itself on this machine, so the kubectl equivalents
 * only carry the flags they need: the kubeconfig files it reads without
 * --kubeconfig ($KUBECONFIG, else ~/.kube/config, as discovery found them),
 * their current context and each context's namespace. Read again after a
 * few seconds: a terminal may switch the current context at any time.
 */
import {
  describeKubeconfig,
  discoveredKubeconfigs,
  normalizeKubeconfigPath,
  type KubeconfigReport,
} from "@/lib/kubeconfigSources";
import type { CommandTarget, KubectlDefaults } from "./command";

const TTL_MS = 5000;
const reports = new Map<string, { at: number; report: Promise<KubeconfigReport | null> }>();

const report = (path: string) => {
  const key = normalizeKubeconfigPath(path);
  const cached = reports.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.report;
  const fresh = describeKubeconfig(path).catch(() => null);
  reports.set(key, { at: Date.now(), report: fresh });
  return fresh;
};

/**
 * The defaults for `targets`. Without discovery results every kubeconfig
 * path is spelled out: an extra flag never hurts, a missing one would.
 */
export async function kubectlDefaults(targets: CommandTarget[]): Promise<KubectlDefaults> {
  const found = discoveredKubeconfigs.value ?? [];
  const env = found.filter((file) => file.origin === "env").map((file) => file.path);
  const chain = env.length > 0 ? env : found.filter((file) => file.origin === "default").map((file) => file.path);

  const paths = [...new Set([...chain, ...targets.map((t) => t.kubeConfig ?? "").filter(Boolean)])];
  const loaded = new Map(
    await Promise.all(paths.map(async (path) => [normalizeKubeconfigPath(path), await report(path)] as const))
  );
  const reportOf = (path: string) => loaded.get(normalizeKubeconfigPath(path)) ?? null;

  return {
    kubeconfigs: chain,
    // Merged files: the first current-context set wins, like kubectl.
    currentContext: (kubeConfig) =>
      kubeConfig
        ? reportOf(kubeConfig)?.currentContext
        : chain.map((path) => reportOf(path)?.currentContext).find(Boolean),
    namespaceOf: (context, kubeConfig) => {
      for (const path of kubeConfig ? [kubeConfig] : chain) {
        const entry = reportOf(path)?.contexts.find((c) => c.name === context);
        if (entry) return entry.namespace;
      }
      return null;
    },
  };
}
