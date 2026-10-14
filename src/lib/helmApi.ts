/*
 * Helm, as the views use it: native reads through the backend (release
 * storage objects, Artifact Hub, chart packages) and the helm CLI for
 * repositories and everything that changes a cluster.
 */
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "@/lib/auth/classify";
import { cliErrorMessage, cliSucceeded, runCli } from "@/actions/command";
import { error as logError } from "@/lib/logger";
import {
  releasesFromCli,
  type ArtifactHubChart,
  type ArtifactHubPackage,
  type ChartMetadata,
  type ChartSearchResult,
  type HelmRelease,
  type HelmReleaseDetail,
  type HelmRepo,
  type HelmRevision,
} from "@/lib/helm";

export interface HelmTarget {
  context: string;
  kubeConfig?: string;
}

/**
 * Backend errors (`SerializableKubeError` objects) as Errors that keep
 * their fields: the auth center still recognises sign-in problems, and
 * banners get a readable message.
 */
export function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const error = new Error(errorText(e));
  return e && typeof e === "object" ? Object.assign(error, e, { message: error.message }) : error;
}

const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw asError(e);
  }
};

const kubeConfigArg = (target: HelmTarget) => target.kubeConfig || null;

/* Auth failures and RBAC denials: helm would fail the same way. */
const noFallback = (e: unknown) => {
  const error = e as { code?: number | null; auth?: unknown };
  return !!error?.auth || error?.code === 401 || error?.code === 403;
};

/**
 * The releases of one cluster, read natively. When that fails for another
 * reason than credentials or permissions, `helm list` is tried instead.
 */
export async function listReleases(target: HelmTarget, namespaces: string[]): Promise<HelmRelease[]> {
  try {
    return await call<HelmRelease[]>("helm_releases", {
      context: target.context,
      kubeConfig: kubeConfigArg(target),
      namespaces,
    });
  } catch (native) {
    if (noFallback(native)) throw native;
    logError(`Reading Helm releases of ${target.context} failed, trying helm list: ${errorText(native)}`);
    const scopes = namespaces.length === 0 || namespaces.includes("all") ? [null] : namespaces;
    const results = await Promise.all(
      scopes.map((ns) =>
        runCli("helm", [
          "list",
          "--output=json",
          `--kube-context=${target.context}`,
          ...(target.kubeConfig ? [`--kubeconfig=${target.kubeConfig}`] : []),
          ...(ns ? [`--namespace=${ns}`] : ["--all-namespaces"]),
          // helm list hides pending releases by default.
          "--deployed",
          "--failed",
          "--pending",
        ])
      )
    );
    const failed = results.find((r) => !cliSucceeded(r));
    if (failed) throw native;
    return results.flatMap((r) => releasesFromCli(JSON.parse(r.stdout || "[]")));
  }
}

export const releaseHistory = (target: HelmTarget, namespace: string, name: string) =>
  call<HelmRevision[]>("helm_history", {
    context: target.context,
    kubeConfig: kubeConfigArg(target),
    namespace,
    name,
  });

export const releaseDetail = (
  target: HelmTarget,
  namespace: string,
  name: string,
  revision?: number
) =>
  call<HelmReleaseDetail>("helm_release_detail", {
    context: target.context,
    kubeConfig: kubeConfigArg(target),
    namespace,
    name,
    revision: revision ?? null,
  });

/* --------------------------------------------------------------- charts -- */

export interface ChartPackage {
  metadata: ChartMetadata;
  values: string;
  valuesSchema?: Record<string, unknown> | null;
  readme: string;
}

/** Chart.yaml, default values, schema and README (helm pull). */
export const inspectChart = (reference: string, version?: string) =>
  call<ChartPackage>("helm_chart_inspect", { reference, version: version || null });

export const artifactHubSearch = (query: string, limit = 24, offset = 0) =>
  call<{ total: number; charts: ArtifactHubChart[] }>("artifacthub_search", { query, limit, offset });

export const artifactHubPackage = (repo: string, name: string, version?: string) =>
  call<ArtifactHubPackage>("artifacthub_package", { repo, name, version: version || null });

export const artifactHubValues = (packageId: string, version: string) =>
  call<string>("artifacthub_values", { packageId, version });

export const artifactHubValuesSchema = (packageId: string, version: string) =>
  call<Record<string, unknown> | null>("artifacthub_values_schema", { packageId, version });

/* Logos by image id: a data URL, or null when it couldn't be loaded. */
const logos = new Map<string, Promise<string | null>>();
export function artifactHubLogo(imageId: string): Promise<string | null> {
  let logo = logos.get(imageId);
  if (!logo) {
    logo = invoke<string>("artifacthub_logo", { imageId }).catch(() => null);
    logos.set(imageId, logo);
  }
  return logo;
}

/* -------------------------------------------------------- repositories -- */

const helmOrThrow = async (args: string[]) => {
  const result = await runCli("helm", args);
  if (!cliSucceeded(result)) throw new Error(cliErrorMessage(result));
  return result.stdout;
};

/** Configured repositories; none is not an error. */
export async function listRepos(): Promise<HelmRepo[]> {
  const result = await runCli("helm", ["repo", "list", "--output=json"]);
  if (!cliSucceeded(result)) {
    // helm reports "no repositories to show" as an error.
    if (/no repositories/i.test(result.stderr)) return [];
    throw new Error(cliErrorMessage(result));
  }
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed)
    ? parsed.map((r: any) => ({ name: String(r.name), url: String(r.url) }))
    : [];
}

export const addRepo = (name: string, url: string) =>
  helmOrThrow(["repo", "add", name.trim(), url.trim(), "--force-update"]);

export const updateRepos = (names: string[] = []) => helmOrThrow(["repo", "update", ...names]);

export const removeRepo = (name: string) => helmOrThrow(["repo", "remove", name]);

/** `helm search repo` (latest versions; every version of one chart with `versions`). */
export async function searchRepos(query: string, versions = false): Promise<ChartSearchResult[]> {
  const result = await runCli("helm", [
    "search",
    "repo",
    ...(query.trim() ? [query.trim()] : []),
    ...(versions ? ["--versions"] : []),
    "--output=json",
  ]);
  if (!cliSucceeded(result)) {
    if (/no repositories/i.test(result.stderr)) return [];
    throw new Error(cliErrorMessage(result));
  }
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [];
}
