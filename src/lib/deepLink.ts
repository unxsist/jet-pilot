/*
 * jetpilot:// links, for Slack, runbooks and alert annotations:
 *
 *   jetpilot://open?context=prod&kind=Deployment&apiVersion=apps/v1&namespace=shop&name=checkout-api
 *   jetpilot://list?context=prod&kind=Deployment&apiVersion=apps/v1&namespace=shop
 *   jetpilot://helm?context=prod&namespace=shop&name=checkout
 *   jetpilot://health?tab=problems
 *
 * `kubeconfig` is added when the context isn't in ~/.kube/config, with the
 * home directory written as ~ so a link works on a teammate's machine.
 * Links only navigate: opening one never changes anything, and it only
 * resolves to a cluster JET Pilot already knows (a link's kubeconfig path is
 * matched against the known ones, never read).
 */

export const SCHEME = "jetpilot";

export interface LinkCluster {
  context: string;
  /** As written in the link ("~/..." allowed); absent: any kubeconfig. */
  kubeConfig?: string;
}

export type DeepLink =
  | ({ type: "object"; kind: string; apiVersion?: string; namespace?: string; name: string } & LinkCluster)
  | ({ type: "list"; kind: string; apiVersion?: string; namespace?: string } & LinkCluster)
  | ({ type: "helm"; namespace: string; name: string } & LinkCluster)
  | { type: "health"; tab?: string };

export type ParsedLink = { ok: true; link: DeepLink } | { ok: false; reason: string };

/* Generous versions of the Kubernetes rules: enough to reject junk and anything that looks like a flag. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const KIND = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const API_VERSION = /^(?:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/)?v[0-9]+(?:(alpha|beta)[0-9]+)?$/;
const TAB = /^[a-z][a-z-]{0,30}$/;
const CONTEXT_MAX = 512;

const fail = (reason: string): ParsedLink => ({ ok: false, reason });

/* Readable in chat: `/`, `:` and `@` are fine in a query. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%40/g, "@");

const query = (params: [string, string | undefined][]) =>
  params
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join("&");

/** `<home>/x` → `~/x`; backslashes as slashes (Windows). */
export function collapseHome(path: string, home: string): string {
  const normal = path.replace(/\\/g, "/");
  const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && (normal === base || normal.startsWith(`${base}/`))) return `~${normal.slice(base.length)}`;
  return normal;
}

/** The link's kubeconfig: none for the default one. */
export function linkKubeConfig(kubeConfig: string | undefined, home: string): string | undefined {
  if (!kubeConfig) return undefined;
  const collapsed = collapseHome(kubeConfig, home);
  return collapsed === "~/.kube/config" ? undefined : collapsed;
}

export function buildLink(link: DeepLink, home = ""): string {
  if (link.type === "health") return `${SCHEME}://health${link.tab ? `?${query([["tab", link.tab]])}` : ""}`;
  const cluster: [string, string | undefined][] = [
    ["context", link.context],
    ["kubeconfig", linkKubeConfig(link.kubeConfig, home)],
  ];
  switch (link.type) {
    case "object":
      return `${SCHEME}://open?${query([
        ...cluster,
        ["kind", link.kind],
        ["apiVersion", link.apiVersion],
        ["namespace", link.namespace],
        ["name", link.name],
      ])}`;
    case "list":
      return `${SCHEME}://list?${query([
        ...cluster,
        ["kind", link.kind],
        ["apiVersion", link.apiVersion],
        ["namespace", link.namespace],
      ])}`;
    case "helm":
      return `${SCHEME}://helm?${query([...cluster, ["namespace", link.namespace], ["name", link.name]])}`;
  }
}

/** A table row or panel object, tagged with its cluster. */
export interface LinkableObject {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string; namespace?: string; context?: string; kubeConfig?: string };
}

/** The link to an object from a table or the side panel. */
export function objectLink(object: LinkableObject | null | undefined, home = ""): string | null {
  const metadata = object?.metadata;
  if (!object?.kind || !metadata?.name || !metadata?.context) return null;
  return buildLink(
    {
      type: "object",
      context: metadata.context,
      kubeConfig: metadata.kubeConfig || undefined,
      kind: object.kind,
      apiVersion: object.apiVersion || undefined,
      namespace: metadata.namespace || undefined,
      name: metadata.name,
    },
    home
  );
}

export function parseLink(url: string): ParsedLink {
  const trimmed = url.trim();
  const match = /^jetpilot:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(trimmed);
  if (!match) return fail("This isn't a JET Pilot link.");
  const action = match[1].replace(/\/+$/, "").toLowerCase();
  const params = new URLSearchParams(match[2] ?? "");
  const get = (key: string) => params.get(key)?.trim() || undefined;

  if (action === "health") {
    const tab = get("tab");
    if (tab && !TAB.test(tab)) return fail(`"${tab}" isn't a Health tab.`);
    return { ok: true, link: { type: "health", tab } };
  }

  const context = get("context");
  if (!context) return fail("The link doesn't say which cluster.");
  if (context.length > CONTEXT_MAX || /[\u0000-\u001f]/.test(context)) return fail("The link's cluster name isn't valid.");
  const kubeConfig = get("kubeconfig");
  if (kubeConfig && /[\u0000-\u001f]/.test(kubeConfig)) return fail("The link's kubeconfig isn't valid.");
  const cluster: LinkCluster = kubeConfig ? { context, kubeConfig } : { context };

  const namespace = get("namespace");
  if (namespace && !NAME.test(namespace)) return fail(`"${namespace}" isn't a namespace.`);
  const name = get("name");
  if (name && !NAME.test(name)) return fail(`"${name}" isn't a valid name.`);

  if (action === "helm") {
    if (!namespace || !name) return fail("The link doesn't say which Helm release.");
    return { ok: true, link: { type: "helm", ...cluster, namespace, name } };
  }

  if (action !== "open" && action !== "list") return fail("JET Pilot doesn't know this kind of link. It may need a newer version.");
  const kind = get("kind");
  if (!kind) return fail("The link doesn't say which kind of object.");
  if (!KIND.test(kind)) return fail(`"${kind}" isn't a kind.`);
  const apiVersion = get("apiVersion");
  if (apiVersion && !API_VERSION.test(apiVersion)) return fail(`"${apiVersion}" isn't an API version.`);
  const typed = { kind, ...(apiVersion ? { apiVersion } : {}), ...(namespace ? { namespace } : {}) };

  if (action === "list") return { ok: true, link: { type: "list", ...cluster, ...typed } };
  if (!name) return fail("The link doesn't say which object.");
  return { ok: true, link: { type: "object", ...cluster, ...typed, name } };
}

export interface KnownContext {
  context: string;
  kubeConfig: string;
}

/**
 * The known context a link points at: its kubeconfig and name, else the
 * only context of that name, else (several kubeconfigs define it) one in a
 * file of the same name, else the first. Null when no known context has
 * that name.
 */
export function matchContext(
  link: LinkCluster,
  known: readonly KnownContext[],
  home: string
): KnownContext | null {
  const named = known.filter((entry) => entry.context === link.context);
  if (named.length === 0) return null;
  if (link.kubeConfig) {
    const wanted = collapseHome(link.kubeConfig, home);
    const exact = named.find((entry) => collapseHome(entry.kubeConfig, home) === wanted);
    if (exact) return exact;
  } else {
    const fallback = named.find((entry) => linkKubeConfig(entry.kubeConfig, home) === undefined);
    if (fallback) return fallback;
  }
  if (named.length === 1) return named[0];
  const file = link.kubeConfig?.replace(/\\/g, "/").split("/").pop();
  return named.find((entry) => entry.kubeConfig.replace(/\\/g, "/").split("/").pop() === file) ?? named[0];
}
