/*
 * Harness mock of `kube_request` (src-tauri/src/kube_api.rs): raw API
 * requests are matched against registered routes. Feature mocks register
 * their own routes from their own module, so setup.ts only imports them:
 *
 *   registerKubeRoutes([
 *     { method: "GET", path: /^\/apis\/kustomize\.toolkit\.fluxcd\.io\/v1\//, handle: (req) => ({ items: [] }) },
 *   ]);
 *
 * A handler gets the request plus the regex match and returns the response
 * body (serialised to JSON; strings are returned as is). Throw a
 * `kubeError(...)` to answer with an API error.
 */

export interface MockKubeRequest {
  context: string;
  kubeConfig?: string | null;
  method: string;
  path: string;
  /** The path without its query. */
  pathname: string;
  query: URLSearchParams;
  body: any;
  contentType?: string | null;
}

export interface KubeRoute {
  method: string | string[];
  path: RegExp;
  handle: (request: MockKubeRequest, match: RegExpMatchArray) => unknown | Promise<unknown>;
}

const routes: KubeRoute[] = [];

export function registerKubeRoutes(list: KubeRoute[]): void {
  routes.push(...list);
}

/** An API error in the shape of `SerializableKubeError`. */
export function kubeError(code: number, message: string, reason = "") {
  return { message, code, reason: reason || null, details: null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleKubeRequest(payload: any): Promise<string> {
  const request = payload.request ?? {};
  const method = String(request.method ?? "GET").toUpperCase();
  const path = String(request.path ?? "");
  const [pathname, search = ""] = path.split("?");
  const mock: MockKubeRequest = {
    context: payload.context,
    kubeConfig: payload.kubeConfig,
    method,
    path,
    pathname,
    query: new URLSearchParams(search),
    body: request.body,
    contentType: request.contentType,
  };
  await sleep(60);
  for (const route of routes) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes(method)) continue;
    const match = pathname.match(route.path);
    if (!match) continue;
    const body = await route.handle(mock, match);
    return typeof body === "string" ? body : JSON.stringify(body ?? null);
  }
  console.warn("[harness] unhandled kube_request", method, path);
  throw kubeError(404, `the server could not find the requested resource (${method} ${pathname})`, "NotFound");
}
