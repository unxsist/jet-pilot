/*
 * Runs the Risks check for one cluster: one-off lists over the raw API (no
 * watches: the tab checks on demand), TLS certificates through the backend
 * and the kubeconfig's credential status, then the pure rules. A list that
 * can't be read (RBAC, a missing CRD) leaves its rules out and is named in
 * `skipped`; only the core lists failing fails the check.
 */
import { invoke } from "@tauri-apps/api/core";
import { apiPath, kubeGet, type KubeTarget } from "@/lib/kubeApi";
import type { HealthTarget } from "@/lib/health/tabs";
import type { CredentialStatus } from "@/lib/auth/types";
import type { RiskItem } from "./rules";
import { clientCertificateRisk, expiryRisks, type TlsCertificate } from "./expiry";
import { unusedRisks } from "./unused";
import { drainRisks, workloadRisks, workloadsOf } from "./workloads";

export interface RiskReport {
  items: RiskItem[];
  /** What couldn't be read, in words ("volumes", "TLS secrets"). */
  skipped: string[];
}

const kubeTarget = (target: { context: string; kubeConfig: string }): KubeTarget => ({
  context: target.context,
  kubeConfig: target.kubeConfig || undefined,
});

export const allNamespaces = (namespaces: string[]) => !namespaces.length || namespaces.includes("all");

/** Items of a list in `namespaces` (["all"]: one cluster-wide list). */
export async function listIn(
  target: { context: string; kubeConfig: string },
  apiVersion: string,
  resource: string,
  namespaces: string[] = ["all"]
): Promise<any[]> {
  const scopes = allNamespaces(namespaces) ? [undefined] : namespaces;
  const lists = await Promise.all(
    scopes.map((namespace) => kubeGet<{ items?: any[] }>(kubeTarget(target), apiPath({ apiVersion, resource, namespace })))
  );
  return lists.flatMap((list) => list?.items ?? []);
}

const notFound = (error: unknown) => (error as { code?: number })?.code === 404;

export async function checkRisks(target: HealthTarget, production: boolean, now = Date.now()): Promise<RiskReport> {
  const skipped: string[] = [];
  const ns = target.namespaces;
  const optional = async <T>(what: string, load: () => Promise<T>, fallback: T, quietIfMissing = false): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      if (!(quietIfMissing && notFound(error))) skipped.push(what);
      return fallback;
    }
  };

  const [pods, deployments, statefulsets, daemonsets] = await Promise.all([
    listIn(target, "v1", "pods", ns),
    listIn(target, "apps/v1", "deployments", ns),
    listIn(target, "apps/v1", "statefulsets", ns),
    listIn(target, "apps/v1", "daemonsets", ns),
  ]);
  const [cronjobs, services, pdbs, hpas, claims, volumes, certificates, tls, credential] = await Promise.all([
    optional("cron jobs", () => listIn(target, "batch/v1", "cronjobs", ns), []),
    optional("services", () => listIn(target, "v1", "services", ns), []),
    optional("disruption budgets", () => listIn(target, "policy/v1", "poddisruptionbudgets", ns), []),
    optional("autoscalers", () => listIn(target, "autoscaling/v2", "horizontalpodautoscalers", ns), []),
    optional("volume claims", () => listIn(target, "v1", "persistentvolumeclaims", ns), []),
    // Volumes are cluster-wide: only with every namespace selected.
    allNamespaces(ns) ? optional("volumes", () => listIn(target, "v1", "persistentvolumes"), []) : Promise.resolve([]),
    optional("cert-manager certificates", () => listIn(target, "cert-manager.io/v1", "certificates", ns), [], true),
    optional(
      "TLS secrets",
      () =>
        invoke<TlsCertificate[]>("tls_certificates", {
          context: target.context,
          kubeConfig: target.kubeConfig || null,
          namespaces: ns,
        }),
      []
    ),
    invoke<CredentialStatus[]>("auth_credential_status", {
      contexts: [{ context: target.context, kubeConfig: target.kubeConfig }],
    }).then(
      (statuses) => statuses?.[0] ?? null,
      () => null
    ),
  ]);

  const scope = { context: target.context, kubeConfig: target.kubeConfig };
  const workloads = workloadsOf({ deployments, statefulsets, daemonsets, cronjobs });
  const client = clientCertificateRisk({ ...scope, now, credential });
  return {
    items: [
      ...(client ? [client] : []),
      ...expiryRisks({ ...scope, now, certificates, tls }),
      ...drainRisks({ ...scope, pdbs, pods }),
      ...workloadRisks({ ...scope, production, workloads, pods, pdbs, hpas }),
      ...unusedRisks({ ...scope, now, workloads, pods, services, claims, volumes }),
    ],
    skipped,
  };
}
