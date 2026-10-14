/*
 * Raw Kubernetes API requests for one context, through the backend's cached
 * client (`kube_request`): the same credentials, sign-in handling and error
 * shape (`KubernetesError`) as every other command.
 *
 *   await kubeGet(target, "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations")
 *   await kubePatch(target, path, { metadata: { annotations: { ... } } })
 *   await kubeServiceProxy(target, { namespace, service, port }, "/api/v1/query?query=up")
 *
 * Paths are absolute API paths; use `apiPath()` to build them.
 */
import { invoke } from "@tauri-apps/api/core";

export interface KubeTarget {
  context: string;
  kubeConfig?: string;
}

export type PatchType = "merge" | "json" | "strategic" | "apply";

const PATCH_CONTENT_TYPES: Record<PatchType, string> = {
  merge: "application/merge-patch+json",
  json: "application/json-patch+json",
  strategic: "application/strategic-merge-patch+json",
  apply: "application/apply-patch+yaml",
};

export interface KubeRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  contentType?: string;
  accept?: string;
}

const decoder = new TextDecoder();

/* The command returns raw bytes (an ArrayBuffer) in the app, a string in tests. */
const toText = (raw: unknown): string =>
  typeof raw === "string"
    ? raw
    : raw instanceof ArrayBuffer
      ? decoder.decode(raw)
      : ArrayBuffer.isView(raw)
        ? decoder.decode(raw as Uint8Array)
        : JSON.stringify(raw);

/** A request; resolves to the response body as text. */
export async function kubeRequestText(
  target: KubeTarget,
  path: string,
  options: KubeRequestOptions = {}
): Promise<string> {
  const raw = await invoke<unknown>("kube_request", {
    context: target.context,
    kubeConfig: target.kubeConfig || null,
    request: {
      method: options.method ?? "GET",
      path,
      body: options.body ?? null,
      contentType: options.contentType ?? null,
      accept: options.accept ?? null,
    },
  });
  return toText(raw);
}

/** A request; resolves to the parsed JSON body (`null` for an empty one). */
export async function kubeRequest<T = any>(
  target: KubeTarget,
  path: string,
  options: KubeRequestOptions = {}
): Promise<T> {
  const text = await kubeRequestText(target, path, options);
  return (text.trim() ? JSON.parse(text) : null) as T;
}

export const kubeGet = <T = any>(target: KubeTarget, path: string) =>
  kubeRequest<T>(target, path);

export const kubePatch = <T = any>(
  target: KubeTarget,
  path: string,
  patch: unknown,
  type: PatchType = "merge"
) =>
  kubeRequest<T>(target, path, {
    method: "PATCH",
    body: patch,
    contentType: PATCH_CONTENT_TYPES[type],
  });

export const kubePost = <T = any>(target: KubeTarget, path: string, body: unknown) =>
  kubeRequest<T>(target, path, { method: "POST", body });

export const kubeDelete = <T = any>(target: KubeTarget, path: string) =>
  kubeRequest<T>(target, path, { method: "DELETE" });

export interface ApiPathParts {
  /** "v1" (core) or "group/version", like an object's apiVersion. */
  apiVersion: string;
  /** Plural resource name, e.g. "kustomizations". */
  resource: string;
  namespace?: string;
  name?: string;
  /** Subresource, e.g. "status" or "scale". */
  subresource?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

/** The API path of a resource collection or object. */
export function apiPath(parts: ApiPathParts): string {
  const base = parts.apiVersion.includes("/")
    ? `/apis/${parts.apiVersion}`
    : `/api/${parts.apiVersion}`;
  const segments = [base];
  if (parts.namespace) segments.push("namespaces", encodeURIComponent(parts.namespace));
  segments.push(parts.resource);
  if (parts.name) segments.push(encodeURIComponent(parts.name));
  if (parts.subresource) segments.push(parts.subresource);
  return segments.join("/").replace(/\/+/g, "/") + queryString(parts.query);
}

export function queryString(
  query?: Record<string, string | number | boolean | undefined>
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface ServiceRef {
  namespace: string;
  service: string;
  /** Port name or number. */
  port: string | number;
  scheme?: "http" | "https";
}

/** The API server's proxy path to a service, e.g. for Prometheus queries. */
export function serviceProxyPath(ref: ServiceRef, path: string): string {
  const scheme = ref.scheme ?? "http";
  // Colons stay literal, like kubectl's proxy paths.
  const name = [scheme, ref.service, String(ref.port)].map(encodeURIComponent).join(":");
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `/api/v1/namespaces/${encodeURIComponent(ref.namespace)}/services/${name}/proxy${rest}`;
}

/** GET through the service proxy; resolves to parsed JSON. */
export const kubeServiceProxy = <T = any>(
  target: KubeTarget,
  ref: ServiceRef,
  path: string
) => kubeGet<T>(target, serviceProxyPath(ref, path));
