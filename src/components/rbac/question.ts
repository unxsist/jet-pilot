/*
 * The words of an access question ("Can I [verb] [resource] in
 * [namespace]?"): the options of each token and how a question turns into
 * an access request.
 */
import type { DiscoveredResource, DiscoverySnapshot } from "@/lib/discovery";
import type { AccessRequest } from "@/lib/rbac";

export interface TokenOption {
  value: string;
  label: string;
  /** Muted text after the label (an API group, "read one", ...). */
  hint?: string;
  /** Heading the option is listed under. */
  section?: string;
  /** Extra words that find it. */
  keywords?: string;
}

/** The resource token's value for a non-resource URL ("/metrics"). */
export const URL_RESOURCE = "@url";
/** The namespace token's value for "every namespace" (Can I: cluster-wide). */
export const EVERY_NAMESPACE = "@all";

export const VERB_OPTIONS: TokenOption[] = [
  { value: "get", label: "get", hint: "read one", section: "Read" },
  { value: "list", label: "list", hint: "read all", section: "Read" },
  { value: "watch", label: "watch", hint: "follow changes", section: "Read" },
  { value: "create", label: "create", section: "Change" },
  { value: "update", label: "update", section: "Change" },
  { value: "patch", label: "patch", section: "Change" },
  { value: "delete", label: "delete", section: "Change" },
  { value: "deletecollection", label: "deletecollection", hint: "delete many", section: "Change" },
  { value: "impersonate", label: "impersonate", section: "Special" },
  { value: "bind", label: "bind", hint: "grant a role", section: "Special" },
  { value: "escalate", label: "escalate", hint: "edit a role", section: "Special" },
  { value: "approve", label: "approve", section: "Special" },
  { value: "use", label: "use", section: "Special" },
  { value: "*", label: "do anything", hint: "*", section: "Special" },
];

/** "deployments.apps", "pods": the resource token's value (kubectl's style). */
export const resourceValue = (resource: { name: string; group: string }) =>
  resource.group ? `${resource.name}.${resource.group}` : resource.name;

export function parseResourceValue(value: string): { resource: string; group: string } {
  const dot = value.indexOf(".");
  return dot < 0 ? { resource: value, group: "" } : { resource: value.slice(0, dot), group: value.slice(dot + 1) };
}

const groupRank = (group: string) =>
  group === "" ? 0 : !group.includes(".") || group.endsWith(".k8s.io") ? 1 : 2;

/** Every resource of the cluster (plus a non-resource URL), everyday ones first. */
export function resourceOptions(resources: DiscoveredResource[]): TokenOption[] {
  const seen = new Set<string>();
  const options = resources
    .filter((r) => !seen.has(resourceValue(r)) && !!seen.add(resourceValue(r)))
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    .map((r) => ({
      value: resourceValue(r),
      label: r.name,
      hint: r.group || undefined,
      keywords: [r.kind, ...(r.shortNames ?? [])].join(" "),
      section: groupRank(r.group) < 2 ? "Kubernetes" : "Custom resources",
    }));
  return [
    ...options,
    { value: URL_RESOURCE, label: "a URL path", hint: "/metrics, /healthz", keywords: "non-resource url", section: "Other" },
  ];
}

/** Subresources of a resource ("log", "exec", "scale", ...) known to discovery. */
export function subresourceOptions(snapshot: DiscoverySnapshot | null | undefined, resource: string, group: string): TokenOption[] {
  const names = new Set<string>();
  for (const r of Object.values(snapshot?.groups ?? {}).flat()) {
    if (r.group !== group || !r.name.startsWith(`${resource}/`)) continue;
    names.add(r.name.slice(resource.length + 1));
  }
  return [...names].sort().map((name) => ({ value: name, label: name }));
}

export function isNamespaced(resources: DiscoveredResource[], resource: string, group: string): boolean {
  return resources.find((r) => r.name === resource && r.group === group)?.namespaced ?? true;
}

export interface Question {
  verb: string;
  /** resourceValue() or URL_RESOURCE. */
  resource: string;
  /** A namespace or EVERY_NAMESPACE. */
  namespace: string;
  name: string;
  subresource: string;
  /** Non-resource URL path. */
  path: string;
}

/** The access request of a question, for a cluster-scoped resource without namespace. */
export function requestOf(question: Question, namespaced: boolean): AccessRequest {
  if (question.resource === URL_RESOURCE) return { verb: question.verb, path: question.path || "/" };
  const { resource, group } = parseResourceValue(question.resource);
  return {
    verb: question.verb,
    group,
    resource,
    ...(question.subresource ? { subresource: question.subresource } : {}),
    ...(question.name ? { name: question.name } : {}),
    ...(namespaced && question.namespace !== EVERY_NAMESPACE ? { namespace: question.namespace } : {}),
  };
}

/** "list pods in payments", for answers ("Yes, you can …"). */
export function questionText(question: Question, namespaced: boolean): string {
  const verb = question.verb === "*" ? "do anything with" : question.verb;
  if (question.resource === URL_RESOURCE) return `${verb} ${question.path || "/"}`;
  const { resource } = parseResourceValue(question.resource);
  // Subresources in RBAC's own words ("pods/exec"): they're what a role must name.
  let what = question.subresource ? `${resource}/${question.subresource}` : resource;
  if (question.name) what += ` named ${question.name}`;
  if (!namespaced) return `${verb} ${what}`;
  return question.namespace === EVERY_NAMESPACE ? `${verb} ${what} in every namespace` : `${verb} ${what} in ${question.namespace}`;
}
