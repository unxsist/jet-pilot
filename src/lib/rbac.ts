/*
 * Kubernetes RBAC, evaluated client-side: which rules match a request, who
 * can do something (and through which binding, role and rule), what a
 * subject can do, and the plain-English words to explain it.
 *
 * Matching follows the API server's RBAC authorizer
 * (plugin/pkg/auth/authorizer/rbac/rbac.go): `*` wildcards for verbs, API
 * groups and resources, `*\/<subresource>`, resourceNames that only match
 * named requests, nonResourceURLs with a trailing `*` prefix match, and
 * RoleBindings that only grant in their own namespace (also when they bind
 * a ClusterRole). Pure TS: the access review page, the side panels and the
 * harness mock share it.
 */

export interface PolicyRule {
  verbs?: string[] | null;
  apiGroups?: string[] | null;
  resources?: string[] | null;
  resourceNames?: string[] | null;
  nonResourceURLs?: string[] | null;
}

export type SubjectKind = "User" | "Group" | "ServiceAccount";

export interface RbacSubject {
  kind: SubjectKind;
  name: string;
  /** Service accounts only. */
  namespace?: string;
  apiGroup?: string;
}

export interface RoleRef {
  apiGroup?: string;
  kind: "Role" | "ClusterRole";
  name: string;
}

export interface LabelSelector {
  matchLabels?: Record<string, string> | null;
  matchExpressions?: { key: string; operator: string; values?: string[] | null }[] | null;
}

export interface RbacMeta {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string> | null;
  annotations?: Record<string, string> | null;
  /** Tagged by the app: the context the object was listed from. */
  context?: string;
  kubeConfig?: string;
  [key: string]: unknown;
}

export interface RoleObject {
  apiVersion?: string;
  kind: "Role" | "ClusterRole";
  metadata: RbacMeta;
  rules?: PolicyRule[] | null;
  aggregationRule?: { clusterRoleSelectors?: LabelSelector[] | null } | null;
}

export interface BindingObject {
  apiVersion?: string;
  kind: "RoleBinding" | "ClusterRoleBinding";
  metadata: RbacMeta;
  roleRef: RoleRef;
  subjects?: RbacSubject[] | null;
}

export interface RbacSnapshot {
  roles: RoleObject[];
  clusterRoles: RoleObject[];
  roleBindings: BindingObject[];
  clusterRoleBindings: BindingObject[];
}

export interface ResourceRequest {
  verb: string;
  /** API group, "" for core. */
  group: string;
  /** Plural resource name, e.g. "pods". */
  resource: string;
  subresource?: string;
  name?: string;
  /** "" (or unset): a cluster-scoped request. */
  namespace?: string;
}

export interface NonResourceRequest {
  verb: string;
  /** e.g. "/healthz", "/metrics". */
  path: string;
}

export type AccessRequest = ResourceRequest | NonResourceRequest;

export const isNonResourceRequest = (request: AccessRequest): request is NonResourceRequest =>
  "path" in request;

/* ------------------------------------------------------------ matching -- */

const list = (values?: string[] | null) => values ?? [];

export function verbMatches(rule: PolicyRule, verb: string): boolean {
  return list(rule.verbs).some((v) => v === "*" || v === verb);
}

export function apiGroupMatches(rule: PolicyRule, group: string): boolean {
  return list(rule.apiGroups).some((g) => g === "*" || g === group);
}

/** `resource` alone, or `resource/subresource`; also `*` and `*\/subresource`. */
export function resourceMatches(rule: PolicyRule, resource: string, subresource = ""): boolean {
  const combined = subresource ? `${resource}/${subresource}` : resource;
  return list(rule.resources).some(
    (r) => r === "*" || r === combined || (!!subresource && r === `*/${subresource}`)
  );
}

/** No resourceNames: every name. Otherwise only requests for one of them. */
export function resourceNameMatches(rule: PolicyRule, name = ""): boolean {
  const names = list(rule.resourceNames);
  return names.length === 0 || (!!name && names.includes(name));
}

export function nonResourceURLMatches(rule: PolicyRule, path: string): boolean {
  return list(rule.nonResourceURLs).some(
    (url) => url === "*" || url === path || (url.endsWith("*") && path.startsWith(url.slice(0, -1)))
  );
}

export function ruleAllows(rule: PolicyRule, request: AccessRequest): boolean {
  if (!verbMatches(rule, request.verb)) return false;
  if (isNonResourceRequest(request)) return nonResourceURLMatches(rule, request.path);
  return (
    apiGroupMatches(rule, request.group) &&
    resourceMatches(rule, request.resource, request.subresource) &&
    resourceNameMatches(rule, request.name)
  );
}

/** The rule only matched thanks to a `*` (verb, group or resource). */
export function matchedByWildcard(rule: PolicyRule, request: AccessRequest): boolean {
  if (!list(rule.verbs).includes(request.verb)) return true;
  if (isNonResourceRequest(request)) return !list(rule.nonResourceURLs).includes(request.path);
  const combined = request.subresource ? `${request.resource}/${request.subresource}` : request.resource;
  return !list(rule.apiGroups).includes(request.group) || !list(rule.resources).includes(combined);
}

/** Every verb on every resource of every group: cluster-admin-like. */
export function isFullAccess(rule: PolicyRule): boolean {
  return (
    list(rule.verbs).includes("*") &&
    list(rule.apiGroups).includes("*") &&
    list(rule.resources).includes("*") &&
    list(rule.resourceNames).length === 0
  );
}

export function isNonResourceRule(rule: PolicyRule): boolean {
  return list(rule.nonResourceURLs).length > 0;
}

export function matchesSelector(labels: Record<string, string> | null | undefined, selector: LabelSelector): boolean {
  const own = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (own[key] !== value) return false;
  }
  for (const expression of selector.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(own, expression.key);
    const values = expression.values ?? [];
    switch (expression.operator) {
      case "In":
        if (!has || !values.includes(own[expression.key])) return false;
        break;
      case "NotIn":
        if (has && values.includes(own[expression.key])) return false;
        break;
      case "Exists":
        if (!has) return false;
        break;
      case "DoesNotExist":
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------ subjects -- */

/** Who a request is made as: a user name and the groups it belongs to. */
export interface Identity {
  username?: string;
  groups: string[];
}

export const serviceAccountUsername = (namespace: string, name: string) =>
  `system:serviceaccount:${namespace}:${name}`;

/**
 * The identity of a subject. Service accounts also belong to
 * system:serviceaccounts, system:serviceaccounts:<namespace> and
 * system:authenticated; every signed-in user to system:authenticated. A
 * user's other groups come from the identity provider and aren't known.
 */
export function identityOf(subject: RbacSubject): Identity {
  switch (subject.kind) {
    case "ServiceAccount": {
      const namespace = subject.namespace ?? "";
      return {
        username: serviceAccountUsername(namespace, subject.name),
        groups: ["system:serviceaccounts", `system:serviceaccounts:${namespace}`, "system:authenticated"],
      };
    }
    case "User":
      return {
        username: subject.name,
        groups: subject.name === "system:anonymous" ? ["system:unauthenticated"] : ["system:authenticated"],
      };
    case "Group":
      return { groups: [subject.name] };
  }
}

/** A binding's subject with the namespace a service account defaults to. */
export function normalizeSubject(subject: RbacSubject, binding: BindingObject): RbacSubject {
  if (subject.kind === "ServiceAccount" && !subject.namespace && binding.metadata.namespace) {
    return { ...subject, namespace: binding.metadata.namespace };
  }
  return subject;
}

/**
 * Whether a binding subject applies to an identity: null when it doesn't,
 * else how (`direct`, or the group it applies through).
 */
export function subjectApplies(subject: RbacSubject, identity: Identity): { via: "direct" } | { via: "group"; group: string } | null {
  switch (subject.kind) {
    case "User":
      return identity.username === subject.name ? { via: "direct" } : null;
    case "ServiceAccount":
      return identity.username === serviceAccountUsername(subject.namespace ?? "", subject.name)
        ? { via: "direct" }
        : null;
    case "Group":
      return identity.groups.includes(subject.name) ? { via: "group", group: subject.name } : null;
  }
}

export const subjectKey = (subject: RbacSubject) =>
  `${subject.kind}:${subject.kind === "ServiceAccount" ? subject.namespace ?? "" : ""}:${subject.name}`;

export function parseSubjectKey(key: string): RbacSubject | null {
  const match = key.match(/^(User|Group|ServiceAccount):([^:]*):(.+)$/);
  if (!match) return null;
  const [, kind, namespace, name] = match;
  return kind === "ServiceAccount"
    ? { kind, name, namespace }
    : { kind: kind as SubjectKind, name };
}

const SYSTEM_PREFIXES = ["system:", "eks:", "kubeadm:"];

/** Built-in subjects (controllers, nodes, cloud provider plumbing). */
export function isSystemSubject(subject: RbacSubject): boolean {
  if (SYSTEM_PREFIXES.some((prefix) => subject.name.startsWith(prefix))) return true;
  return subject.kind === "ServiceAccount" && subject.namespace === "kube-system";
}

const WELL_KNOWN_GROUPS: Record<string, string> = {
  "system:authenticated": "Everyone who's signed in",
  "system:unauthenticated": "Anonymous requests",
  "system:serviceaccounts": "Every service account",
  "system:masters": "Cluster superusers",
  "system:nodes": "Every node (kubelet)",
  "system:bootstrappers": "Nodes joining the cluster",
};

/** One quiet line about a subject: what it is, in words. */
export function subjectDescription(subject: RbacSubject): string {
  if (subject.kind === "ServiceAccount") return `Service account in ${subject.namespace || "an unknown namespace"}`;
  if (subject.kind === "User") return subject.name === "system:anonymous" ? "Anonymous requests" : "User";
  const known = WELL_KNOWN_GROUPS[subject.name];
  if (known) return known;
  const namespace = subject.name.match(/^system:serviceaccounts:(.+)$/)?.[1];
  if (namespace) return `Every service account in ${namespace}`;
  return "Group";
}

/** subjectDescription(), but only when it says more than the icon does ("User", "Group"). */
export function subjectHint(subject: RbacSubject): string {
  const description = subjectDescription(subject);
  return description === "User" || description === "Group" ? "" : description;
}

/* --------------------------------------------------------------- index -- */

export interface RbacIndex {
  snapshot: RbacSnapshot;
  role(namespace: string, name: string): RoleObject | undefined;
  clusterRole(name: string): RoleObject | undefined;
  /** The role a binding refers to; null when it doesn't exist (dangling). */
  roleOf(binding: BindingObject): RoleObject | null;
  bindings: BindingObject[];
}

export function indexRbac(snapshot: RbacSnapshot): RbacIndex {
  const roles = new Map(snapshot.roles.map((r) => [`${r.metadata.namespace ?? ""}/${r.metadata.name}`, r]));
  const clusterRoles = new Map(snapshot.clusterRoles.map((r) => [r.metadata.name, r]));
  const role = (namespace: string, name: string) => roles.get(`${namespace}/${name}`);
  const clusterRole = (name: string) => clusterRoles.get(name);
  return {
    snapshot,
    role,
    clusterRole,
    roleOf: (binding) =>
      (binding.roleRef.kind === "ClusterRole"
        ? clusterRole(binding.roleRef.name)
        : // A ClusterRoleBinding can't refer to a Role (the API rejects it).
          binding.kind === "RoleBinding"
          ? role(binding.metadata.namespace ?? "", binding.roleRef.name)
          : undefined) ?? null,
    bindings: [...snapshot.clusterRoleBindings, ...snapshot.roleBindings],
  };
}

/** Where a binding grants: its namespace, or null for everywhere. */
export const bindingScope = (binding: BindingObject): string | null =>
  binding.kind === "RoleBinding" ? binding.metadata.namespace ?? "" : null;

/** Bindings that refer to a role that doesn't exist: they grant nothing. */
export function danglingBindings(index: RbacIndex): BindingObject[] {
  return index.bindings.filter((binding) => !index.roleOf(binding));
}

/** Bindings that grant a role. */
export function bindingsOfRole(index: RbacIndex, role: RoleObject): BindingObject[] {
  return index.bindings.filter((binding) => {
    if (binding.roleRef.name !== role.metadata.name || binding.roleRef.kind !== role.kind) return false;
    return role.kind === "ClusterRole" || binding.metadata.namespace === role.metadata.namespace;
  });
}

/** The ClusterRoles an aggregated ClusterRole collects its rules from. */
export function aggregatedFrom(index: RbacIndex, role: RoleObject): RoleObject[] {
  const selectors = role.aggregationRule?.clusterRoleSelectors ?? [];
  if (!selectors.length) return [];
  return index.snapshot.clusterRoles.filter(
    (other) => other !== role && selectors.some((selector) => matchesSelector(other.metadata.labels, selector))
  );
}

/** The aggregated ClusterRoles a ClusterRole adds its rules to. */
export function aggregatesInto(index: RbacIndex, role: RoleObject): RoleObject[] {
  if (role.kind !== "ClusterRole") return [];
  return index.snapshot.clusterRoles.filter(
    (other) =>
      other !== role &&
      (other.aggregationRule?.clusterRoleSelectors ?? []).some((selector) => matchesSelector(role.metadata.labels, selector))
  );
}

/* ----------------------------------------------------------- who can -- */

/** Where to look: one namespace, cluster-wide grants only, or anywhere. */
export type Scope = { namespace: string } | "cluster" | "anywhere";

export interface MatchedGrant {
  binding: BindingObject;
  role: RoleObject;
  rule: PolicyRule;
  ruleIndex: number;
  /** The binding's subject that applies. */
  subject: RbacSubject;
  /** Namespace the grant is limited to; null: everywhere. */
  namespace: string | null;
  wildcard: boolean;
  fullAccess: boolean;
}

export interface SubjectAccess {
  key: string;
  subject: RbacSubject;
  grants: MatchedGrant[];
  system: boolean;
  /** Has a grant that applies everywhere. */
  everywhere: boolean;
  /** Namespaces with grants (when not everywhere). */
  namespaces: string[];
}

function bindingApplies(binding: BindingObject, request: AccessRequest, scope: Scope): boolean {
  if (binding.kind === "ClusterRoleBinding") return true;
  // RoleBindings grant namespaced resources in their namespace only.
  if (isNonResourceRequest(request) || scope === "cluster") return false;
  if (scope === "anywhere") return true;
  return binding.metadata.namespace === scope.namespace;
}

/** The first rule of a role that allows a request (exact matches first). */
export function matchingRule(role: RoleObject, request: AccessRequest): { rule: PolicyRule; index: number } | null {
  const rules = role.rules ?? [];
  let wildcard: { rule: PolicyRule; index: number } | null = null;
  for (const [index, rule] of rules.entries()) {
    if (!ruleAllows(rule, request)) continue;
    if (!matchedByWildcard(rule, request)) return { rule, index };
    wildcard ??= { rule, index };
  }
  return wildcard;
}

const KIND_ORDER: Record<SubjectKind, number> = { User: 0, Group: 1, ServiceAccount: 2 };

export function compareSubjects(a: RbacSubject, b: RbacSubject): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Every subject a request is allowed for, with each binding → role → rule
 * that allows it. With scope "anywhere", RoleBindings in every namespace
 * count (each grant says where it applies).
 */
export function whoCan(index: RbacIndex, request: AccessRequest, scope: Scope): SubjectAccess[] {
  const bySubject = new Map<string, SubjectAccess>();
  for (const binding of index.bindings) {
    if (!bindingApplies(binding, request, scope)) continue;
    const role = index.roleOf(binding);
    if (!role) continue;
    const match = matchingRule(role, request);
    if (!match) continue;
    for (const raw of binding.subjects ?? []) {
      const subject = normalizeSubject(raw, binding);
      const key = subjectKey(subject);
      let entry = bySubject.get(key);
      if (!entry) {
        entry = { key, subject, grants: [], system: isSystemSubject(subject), everywhere: false, namespaces: [] };
        bySubject.set(key, entry);
      }
      const namespace = bindingScope(binding);
      entry.grants.push({
        binding,
        role,
        rule: match.rule,
        ruleIndex: match.index,
        subject,
        namespace,
        wildcard: matchedByWildcard(match.rule, request),
        fullAccess: isFullAccess(match.rule),
      });
      if (namespace === null) entry.everywhere = true;
      else if (!entry.namespaces.includes(namespace)) entry.namespaces.push(namespace);
    }
  }
  const result = [...bySubject.values()];
  for (const entry of result) {
    entry.namespaces.sort();
    // Cluster-wide grants first: they explain the most.
    entry.grants.sort((a, b) => Number(a.namespace !== null) - Number(b.namespace !== null));
  }
  return result.sort((a, b) => Number(a.system) - Number(b.system) || compareSubjects(a.subject, b.subject));
}

/* ------------------------------------------------- what a subject can do -- */

export interface Grant {
  binding: BindingObject;
  /** null: the binding refers to a role that doesn't exist. */
  role: RoleObject | null;
  subject: RbacSubject;
  /** The group it applies through (system:authenticated, a team, ...). */
  viaGroup?: string;
  /** null: everywhere. */
  namespace: string | null;
}

/** Every binding that applies to an identity. */
export function grantsFor(index: RbacIndex, identity: Identity): Grant[] {
  const grants: Grant[] = [];
  for (const binding of index.bindings) {
    for (const raw of binding.subjects ?? []) {
      const subject = normalizeSubject(raw, binding);
      const applies = subjectApplies(subject, identity);
      if (!applies) continue;
      grants.push({
        binding,
        role: index.roleOf(binding),
        subject,
        viaGroup: applies.via === "group" ? applies.group : undefined,
        namespace: bindingScope(binding),
      });
      break;
    }
  }
  return grants;
}

export interface SourcedRule<S> {
  rule: PolicyRule;
  source: S;
}

/**
 * Whether a resource of an API group is namespaced (API discovery);
 * undefined when it isn't known.
 */
export type NamespacedLookup = (group: string, resource: string) => boolean | undefined;

/**
 * A rule as granted inside a namespace: resources discovery knows to be
 * cluster-scoped (nodes, namespaces, PVs, CRDs, ...) are dropped, since a
 * RoleBinding can't grant them. Unknown resources and `*` stay. null when
 * nothing is left.
 */
export function namespacedPart(rule: PolicyRule, namespaced: NamespacedLookup): PolicyRule | null {
  const groups = list(rule.apiGroups);
  const clusterScoped = (resource: string) => {
    if (resource === "*" || resource.startsWith("*/") || groups.includes("*")) return false;
    const base = resource.split("/")[0];
    return groups.length > 0 && groups.every((group) => namespaced(group, base) === false);
  };
  const resources = list(rule.resources).filter((resource) => !clusterScoped(resource));
  if (resources.length === list(rule.resources).length) return rule;
  return resources.length ? { ...rule, resources } : null;
}

export interface EffectivePermissions {
  /** Rules that apply everywhere (ClusterRoleBindings). */
  everywhere: SourcedRule<Grant>[];
  /** Rules that only apply in one namespace (RoleBindings). */
  namespaces: Map<string, SourcedRule<Grant>[]>;
  /** Bindings to roles that don't exist. */
  dangling: Grant[];
  grants: Grant[];
}

export function effectivePermissions(
  index: RbacIndex,
  identity: Identity,
  namespaced?: NamespacedLookup
): EffectivePermissions {
  const grants = grantsFor(index, identity);
  const result: EffectivePermissions = { everywhere: [], namespaces: new Map(), dangling: [], grants };
  for (const grant of grants) {
    if (!grant.role) {
      result.dangling.push(grant);
      continue;
    }
    const rules: SourcedRule<Grant>[] = [];
    for (const rule of grant.role.rules ?? []) {
      if (grant.namespace === null) {
        rules.push({ rule, source: grant });
        continue;
      }
      // RoleBindings never grant non-resource URLs, nor cluster-scoped resources.
      if (isNonResourceRule(rule)) continue;
      const inNamespace = namespaced ? namespacedPart(rule, namespaced) : rule;
      if (inNamespace) rules.push({ rule: inNamespace, source: grant });
    }
    if (grant.namespace === null) {
      result.everywhere.push(...rules);
    } else {
      const bucket = result.namespaces.get(grant.namespace) ?? [];
      bucket.push(...rules);
      result.namespaces.set(grant.namespace, bucket);
    }
  }
  result.namespaces = new Map([...result.namespaces].sort(([a], [b]) => a.localeCompare(b)));
  return result;
}

/** The subjects of every binding, with how many bindings name them. */
export function subjectsOf(index: RbacIndex): { subject: RbacSubject; key: string; bindings: number; system: boolean }[] {
  const seen = new Map<string, { subject: RbacSubject; key: string; bindings: number; system: boolean }>();
  for (const binding of index.bindings) {
    for (const raw of binding.subjects ?? []) {
      const subject = normalizeSubject(raw, binding);
      const key = subjectKey(subject);
      const entry = seen.get(key);
      if (entry) entry.bindings++;
      else seen.set(key, { subject, key, bindings: 1, system: isSystemSubject(subject) });
    }
  }
  return [...seen.values()].sort((a, b) => compareSubjects(a.subject, b.subject));
}

/* -------------------------------------------------------------- matrix -- */

/** The verbs that get a column; others are listed in words. */
export const MATRIX_VERBS = ["get", "list", "watch", "create", "update", "patch", "delete"] as const;

export interface PermissionRow<S> {
  key: string;
  /** "*": every API group. */
  group: string;
  /** "*": every resource; may be "pods/log" or "*\/scale". */
  resource: string;
  /** Only these names; empty: every name. */
  names: string[];
  /** Every verb ("*"). */
  all: boolean;
  verbs: Set<string>;
  /** Per verb ("*" included): what grants it. */
  sourcesByVerb: Map<string, S[]>;
  sources: S[];
}

export interface PermissionGroup<S> {
  /** "*": every API group, "": core. */
  group: string;
  rows: PermissionRow<S>[];
}

export interface NonResourceRow<S> {
  path: string;
  all: boolean;
  verbs: Set<string>;
  sources: S[];
}

export interface PermissionMatrix<S> {
  groups: PermissionGroup<S>[];
  nonResource: NonResourceRow<S>[];
  /** What grants every verb on everything (cluster-admin-like). */
  fullAccess: S[];
  rowCount: number;
}

const pushUnique = <T>(array: T[], value: T) => {
  if (!array.includes(value)) array.push(value);
};

/**
 * Rules as a readable matrix: one row per (API group, resource, names),
 * merged across rules, grouped by API group. Every group first, then core,
 * then the others by name; inside a group `*` first.
 */
export function permissionMatrix<S>(entries: SourcedRule<S>[]): PermissionMatrix<S> {
  const rows = new Map<string, PermissionRow<S>>();
  const nonResource = new Map<string, NonResourceRow<S>>();
  const fullAccess: S[] = [];

  for (const { rule, source } of entries) {
    const verbs = list(rule.verbs);
    if (!verbs.length) continue;
    if (isNonResourceRule(rule)) {
      for (const path of list(rule.nonResourceURLs)) {
        const row = nonResource.get(path) ?? { path, all: false, verbs: new Set<string>(), sources: [] };
        for (const verb of verbs) row.verbs.add(verb);
        row.all ||= verbs.includes("*");
        pushUnique(row.sources, source);
        nonResource.set(path, row);
      }
      continue;
    }
    if (isFullAccess(rule)) pushUnique(fullAccess, source);
    const names = [...list(rule.resourceNames)].sort();
    for (const group of list(rule.apiGroups)) {
      for (const resource of list(rule.resources)) {
        const key = `${group}|${resource}|${names.join(",")}`;
        let row = rows.get(key);
        if (!row) {
          row = { key, group, resource, names, all: false, verbs: new Set(), sourcesByVerb: new Map(), sources: [] };
          rows.set(key, row);
        }
        for (const verb of verbs) {
          row.verbs.add(verb);
          const bucket = row.sourcesByVerb.get(verb) ?? [];
          pushUnique(bucket, source);
          row.sourcesByVerb.set(verb, bucket);
        }
        row.all ||= verbs.includes("*");
        pushUnique(row.sources, source);
      }
    }
  }

  const groups = new Map<string, PermissionRow<S>[]>();
  for (const row of rows.values()) {
    const bucket = groups.get(row.group) ?? [];
    bucket.push(row);
    groups.set(row.group, bucket);
  }
  const groupRank = (group: string) => (group === "*" ? 0 : group === "" ? 1 : 2);
  const resourceRank = (resource: string) => (resource === "*" ? 0 : resource.startsWith("*/") ? 1 : 2);
  return {
    groups: [...groups.entries()]
      .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
      .map(([group, groupRows]) => ({
        group,
        rows: groupRows.sort(
          (a, b) =>
            resourceRank(a.resource) - resourceRank(b.resource) ||
            a.resource.localeCompare(b.resource) ||
            a.names.length - b.names.length
        ),
      })),
    nonResource: [...nonResource.values()].sort((a, b) => a.path.localeCompare(b.path)),
    fullAccess,
    rowCount: rows.size,
  };
}

/** A verb of a row: granted directly, through `*`, or not. */
export function rowGrants(row: { all: boolean; verbs: Set<string> }, verb: string): boolean {
  return row.all || row.verbs.has(verb);
}

/** Verbs of a row that have no column (escalate, bind, deletecollection, ...). */
export function otherVerbs(row: { verbs: Set<string> }): string[] {
  return [...row.verbs].filter((verb) => verb !== "*" && !(MATRIX_VERBS as readonly string[]).includes(verb)).sort();
}

/** What grants a verb of a row (the `*` sources included). */
export function sourcesOfVerb<S>(row: PermissionRow<S>, verb: string): S[] {
  const sources = [...(row.sourcesByVerb.get(verb) ?? [])];
  for (const source of row.sourcesByVerb.get("*") ?? []) pushUnique(sources, source);
  return sources;
}

/* --------------------------------------------------------------- words -- */

const READ = ["get", "list", "watch"];
const WRITE = ["create", "update", "patch", "delete"];

export function joinWords(words: string[], conjunction = "and"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

/** "read", "read and change", "do anything with", "get and list", ... */
export function verbPhrase(verbs: string[]): string {
  if (verbs.includes("*")) return "do anything with";
  const set = new Set(verbs);
  const reads = READ.every((v) => set.has(v));
  const writes = WRITE.every((v) => set.has(v));
  const rest = verbs.filter((v) => !(reads && READ.includes(v)) && !(writes && WRITE.includes(v)));
  const parts = [...(reads ? ["read"] : []), ...(writes ? ["change"] : []), ...rest];
  return joinWords(parts);
}

export function groupLabel(group: string): string {
  if (group === "*") return "Every API group";
  if (group === "") return "Core";
  return group;
}

/** "pods", "every resource", "deployments/scale", ... */
export function resourceLabel(resource: string): string {
  if (resource === "*") return "every resource";
  if (resource.startsWith("*/")) return `the ${resource.slice(2)} of every resource`;
  return resource;
}

/** One rule in words, e.g. "read pods and services", "do anything with everything". */
export function ruleSummary(rule: PolicyRule): string {
  const verbs = verbPhrase(list(rule.verbs));
  if (isNonResourceRule(rule)) {
    const urls = list(rule.nonResourceURLs);
    return `${verbs} ${urls.includes("*") ? "every non-resource URL" : joinWords(urls)}`;
  }
  if (isFullAccess(rule)) return `${verbs} everything`;
  const resources = list(rule.resources);
  const groups = list(rule.apiGroups);
  let what = resources.includes("*") ? "every resource" : joinWords(resources.map(resourceLabel));
  const names = list(rule.resourceNames);
  if (names.length) what += ` named ${joinWords(names, "or")}`;
  if (groups.includes("*")) what += " in every API group";
  else if (groups.length && !(groups.length === 1 && groups[0] === "")) {
    what += ` (${joinWords(groups.map((g) => (g === "" ? "core" : g)))})`;
  }
  return `${verbs} ${what}`;
}

/**
 * How a wildcard rule matched a request, e.g. "every verb on every
 * resource". null when the rule names the request exactly.
 */
export function wildcardSummary(rule: PolicyRule, request: AccessRequest): string | null {
  if (!matchedByWildcard(rule, request)) return null;
  const verb = list(rule.verbs).includes(request.verb) ? request.verb : "every verb";
  if (isNonResourceRequest(request)) {
    const exact = list(rule.nonResourceURLs).includes(request.path);
    return `${verb} on ${exact ? request.path : "every URL path"}`;
  }
  const combined = request.subresource ? `${request.resource}/${request.subresource}` : request.resource;
  const resources = list(rule.resources);
  const resource = resources.includes(combined)
    ? combined
    : resources.includes("*")
      ? "every resource"
      : `the ${request.subresource} of every resource`;
  const everyGroup = !list(rule.apiGroups).includes(request.group);
  return `${verb} on ${resource}${everyGroup ? " in every API group" : ""}`;
}

/* ---------------------------------------------------------- the server -- */

/** status.resourceRules / nonResourceRules of a SelfSubjectRulesReview. */
export function rulesFromReview(status: {
  resourceRules?: PolicyRule[] | null;
  nonResourceRules?: PolicyRule[] | null;
} | null | undefined): PolicyRule[] {
  return [...(status?.resourceRules ?? []), ...(status?.nonResourceRules ?? [])];
}

export interface AllowReason {
  binding: { kind: "RoleBinding" | "ClusterRoleBinding"; name: string; namespace?: string };
  role: { kind: "Role" | "ClusterRole"; name: string };
  subject: RbacSubject;
}

/**
 * The RBAC authorizer's reason of an allowed access review, e.g.
 * `RBAC: allowed by RoleBinding "deployers/ci" of ClusterRole "edit" to
 * ServiceAccount "deployer/ci"`. null for other authorizers' reasons.
 */
export function parseAllowReason(reason: string | null | undefined): AllowReason | null {
  const match = reason?.match(
    /allowed by (ClusterRoleBinding|RoleBinding) "([^"]+)" of (ClusterRole|Role) "([^"]+)" to (User|Group|ServiceAccount) "([^"]+)"/
  );
  if (!match) return null;
  const [, bindingKind, bindingName, roleKind, roleName, subjectKind, subjectName] = match;
  const split = (value: string) => {
    const slash = value.lastIndexOf("/");
    return slash > 0 ? { name: value.slice(0, slash), namespace: value.slice(slash + 1) } : { name: value };
  };
  const binding =
    bindingKind === "RoleBinding"
      ? { kind: "RoleBinding" as const, ...split(bindingName) }
      : { kind: "ClusterRoleBinding" as const, name: bindingName };
  const subject: RbacSubject =
    subjectKind === "ServiceAccount"
      ? { kind: "ServiceAccount", ...split(subjectName) }
      : { kind: subjectKind as SubjectKind, name: subjectName };
  return { binding, role: { kind: roleKind as "Role" | "ClusterRole", name: roleName }, subject };
}
