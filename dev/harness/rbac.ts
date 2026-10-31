/*
 * RBAC of the harness clusters (the access review, the RBAC side panels
 * and lists) and the API server's answers about it: RBAC lists, the self
 * reviews (SelfSubjectAccessReview, -RulesReview, -Review) and pods by
 * service account. Answers are computed from the fixtures with the app's
 * own engine (src/lib/rbac.ts), so they always agree with them.
 *
 * Who's who:
 *   - acme:platform: cluster-admin (ClusterRoleBinding)
 *   - acme:payments-team: admin in payments (RoleBinding → ClusterRole)
 *   - acme:developers: view everywhere (read-only) and may read RBAC
 *   - platform/ci-deployer: deploys to payments and checkout
 *   - monitoring/prometheus: reads nodes, pods, /metrics
 *   - cert-manager/cert-manager: a wildcard role on cert-manager.io
 *   - checkout/legacy-release-manager: a RoleBinding to a Role that's gone
 *   - admin / edit / view / acme:monitoring-view: aggregated ClusterRoles
 *
 * You are maria@acme.dev (payments team, developers). With
 * ?scenario=rbac-forbidden you are a contractor who may only edit in
 * checkout: listing RBAC objects is forbidden, "Can I" still answers.
 */
import { CLUSTERS, CONTEXTS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";
import {
  type BindingObject,
  type Identity,
  type PolicyRule,
  type RbacSnapshot,
  type RoleObject,
  type AccessRequest,
  grantsFor,
  indexRbac,
  isNonResourceRule,
  ruleAllows,
} from "@/lib/rbac";

/* Imported before setup.ts stores the knobs: the query string comes first. */
const scenario =
  new URLSearchParams(location.search).get("scenario") || localStorage.getItem("harness-scenario") || "default";
const forbidden = scenario === "rbac-forbidden";
const namespacedGitops = scenario === "gitops-namespaced";

const ME: Identity = forbidden
  ? { username: "sam@partner.io", groups: ["partner:contractors", "system:authenticated"] }
  : { username: "maria@acme.dev", groups: ["acme:payments-team", "acme:developers", "system:authenticated"] };

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
let uid = 0;
const meta = (name: string, namespace?: string, extra: Record<string, unknown> = {}) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: `rbac-${(++uid).toString(16).padStart(6, "0")}-4c1d-9a7e`,
  resourceVersion: String(4000 + uid),
  creationTimestamp: ago(extra.age as number ?? 90),
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "age")),
});

const ALL = ["*"];
const READ = ["get", "list", "watch"];
const WRITE = ["create", "delete", "deletecollection", "patch", "update"];
const rule = (verbs: string[], apiGroups: string[], resources: string[], resourceNames?: string[]): PolicyRule => ({
  verbs,
  apiGroups,
  resources,
  ...(resourceNames ? { resourceNames } : {}),
});
const nonResource = (verbs: string[], nonResourceURLs: string[]): PolicyRule => ({ verbs, nonResourceURLs });

const BOOTSTRAP = { "kubernetes.io/bootstrapping": "rbac-defaults" };
const AGG = "rbac.authorization.k8s.io/aggregate-to-";

const clusterRole = (name: string, rules: PolicyRule[], extra: Partial<RoleObject> & { labels?: Record<string, string>; age?: number } = {}): RoleObject => {
  const { labels, age, ...rest } = extra;
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: meta(name, undefined, { ...(labels ? { labels } : {}), age: age ?? 210 }),
    rules,
    ...rest,
  };
};
const role = (namespace: string, name: string, rules: PolicyRule[], age = 40): RoleObject => ({
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "Role",
  metadata: meta(name, namespace, { labels: { "app.kubernetes.io/managed-by": "Helm" }, age }),
  rules,
});
const user = (name: string) => ({ kind: "User" as const, apiGroup: "rbac.authorization.k8s.io", name });
const group = (name: string) => ({ kind: "Group" as const, apiGroup: "rbac.authorization.k8s.io", name });
const sa = (namespace: string, name: string) => ({ kind: "ServiceAccount" as const, name, namespace });
const crb = (name: string, roleName: string, subjects: BindingObject["subjects"], age = 120, labels?: Record<string, string>): BindingObject => ({
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "ClusterRoleBinding",
  metadata: meta(name, undefined, { ...(labels ? { labels } : {}), age }),
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: roleName },
  subjects,
});
const rb = (namespace: string, name: string, roleKind: "Role" | "ClusterRole", roleName: string, subjects: BindingObject["subjects"], age = 40): BindingObject => ({
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "RoleBinding",
  metadata: meta(name, namespace, { age }),
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: roleKind, name: roleName },
  subjects,
});

/* The built-in user-facing roles, with their aggregated rules (abridged). */
const VIEW_RULES = [
  rule(READ, [""], ["configmaps", "endpoints", "persistentvolumeclaims", "pods", "replicationcontrollers", "serviceaccounts", "services", "events", "limitranges", "resourcequotas", "pods/log", "pods/status"]),
  rule(READ, [""], ["namespaces"]),
  rule(READ, ["apps"], ["daemonsets", "deployments", "replicasets", "statefulsets", "deployments/scale"]),
  rule(READ, ["autoscaling"], ["horizontalpodautoscalers"]),
  rule(READ, ["batch"], ["cronjobs", "jobs"]),
  rule(READ, ["networking.k8s.io"], ["ingresses", "networkpolicies"]),
  rule(READ, ["policy"], ["poddisruptionbudgets"]),
  rule(READ, ["monitoring.coreos.com"], ["prometheusrules", "servicemonitors", "podmonitors"]),
];
const EDIT_RULES = [
  rule([...READ, ...WRITE], [""], ["configmaps", "persistentvolumeclaims", "pods", "replicationcontrollers", "secrets", "serviceaccounts", "services", "pods/attach", "pods/exec", "pods/portforward", "pods/proxy"]),
  rule([...READ, ...WRITE], ["apps"], ["daemonsets", "deployments", "replicasets", "statefulsets", "deployments/scale", "statefulsets/scale", "deployments/rollback"]),
  rule([...READ, ...WRITE], ["autoscaling"], ["horizontalpodautoscalers"]),
  rule([...READ, ...WRITE], ["batch"], ["cronjobs", "jobs"]),
  rule([...READ, ...WRITE], ["networking.k8s.io"], ["ingresses", "networkpolicies"]),
  rule([...READ, ...WRITE], ["policy"], ["poddisruptionbudgets"]),
  rule(["impersonate"], [""], ["serviceaccounts"]),
  ...VIEW_RULES.slice(1),
  rule(READ, [""], ["events", "limitranges", "resourcequotas", "pods/log", "pods/status", "endpoints"]),
];
const ADMIN_RULES = [
  ...EDIT_RULES,
  rule([...READ, ...WRITE], ["rbac.authorization.k8s.io"], ["rolebindings", "roles"]),
  rule(["create"], ["authorization.k8s.io"], ["localsubjectaccessreviews"]),
];

function buildRbac(full: boolean): RbacSnapshot {
  const clusterRoles: RoleObject[] = [
    clusterRole("cluster-admin", [rule(ALL, ALL, ALL), nonResource(ALL, ALL)], { labels: BOOTSTRAP }),
    clusterRole("admin", ADMIN_RULES, {
      labels: BOOTSTRAP,
      aggregationRule: { clusterRoleSelectors: [{ matchLabels: { [`${AGG}admin`]: "true" } }] },
    }),
    clusterRole("edit", EDIT_RULES, {
      labels: { ...BOOTSTRAP, [`${AGG}admin`]: "true" },
      aggregationRule: { clusterRoleSelectors: [{ matchLabels: { [`${AGG}edit`]: "true" } }] },
    }),
    clusterRole("view", VIEW_RULES, {
      labels: { ...BOOTSTRAP, [`${AGG}edit`]: "true" },
      aggregationRule: { clusterRoleSelectors: [{ matchLabels: { [`${AGG}view`]: "true" } }] },
    }),
    clusterRole("acme:monitoring-view", [rule(READ, ["monitoring.coreos.com"], ["prometheusrules", "servicemonitors", "podmonitors"])], {
      labels: { [`${AGG}view`]: "true", "app.kubernetes.io/part-of": "kube-prometheus" },
      age: 88,
    }),
    clusterRole("acme:rbac-reader", [rule(READ, ["rbac.authorization.k8s.io"], ["clusterroles", "clusterrolebindings", "roles", "rolebindings"])], { age: 60 }),
    // Developers see the nodes their pods run on (Health › Problems lists nodes in trouble).
    clusterRole("acme:node-reader", [rule(READ, [""], ["nodes"])], { age: 45 }),
    clusterRole("ci-deployer", [
      rule([...READ, "update", "patch"], ["apps"], ["deployments", "statefulsets", "daemonsets"]),
      rule(["update", "patch"], ["apps"], ["deployments/scale", "statefulsets/scale"]),
      rule([...READ, "create", "update", "patch"], [""], ["configmaps", "services"]),
      rule(["get"], [""], ["secrets"], ["registry-credentials"]),
      rule(["create", "delete", "get", "list"], ["batch"], ["jobs"]),
      // Cluster-scoped: granted through its RoleBindings, this does nothing.
      rule(["get"], [""], ["namespaces"]),
    ], { age: 30 }),
    clusterRole("prometheus", [
      rule(READ, [""], ["nodes", "nodes/metrics", "services", "endpoints", "pods"]),
      rule(READ, ["networking.k8s.io"], ["ingresses"]),
      nonResource(["get"], ["/metrics", "/metrics/cadvisor"]),
    ], { labels: { "app.kubernetes.io/part-of": "kube-prometheus" }, age: 88 }),
    clusterRole("cert-manager-controller", [
      rule(ALL, ["cert-manager.io", "acme.cert-manager.io"], ALL),
      rule(["get", "list", "watch", "create", "update", "delete"], [""], ["secrets"]),
      rule(["create", "patch"], [""], ["events"]),
    ], { labels: { "app.kubernetes.io/name": "cert-manager" }, age: 120 }),
    // The defaults every cluster has.
    clusterRole("system:discovery", [nonResource(["get"], ["/api", "/api/*", "/apis", "/apis/*", "/healthz", "/livez", "/openapi", "/openapi/*", "/readyz", "/version", "/version/"])], { labels: BOOTSTRAP }),
    clusterRole("system:basic-user", [rule(["create"], ["authorization.k8s.io"], ["selfsubjectaccessreviews", "selfsubjectrulesreviews"]), rule(["create"], ["authentication.k8s.io"], ["selfsubjectreviews"])], { labels: BOOTSTRAP }),
    clusterRole("system:public-info-viewer", [nonResource(["get"], ["/healthz", "/livez", "/readyz", "/version", "/version/"])], { labels: BOOTSTRAP }),
    clusterRole("system:kube-scheduler", [rule(["create", "patch", "update"], ["", "events.k8s.io"], ["events"]), rule(READ, [""], ["pods", "nodes", "namespaces"]), rule(["create"], [""], ["pods/binding", "bindings"])], { labels: BOOTSTRAP }),
    clusterRole("system:kube-controller-manager", [rule(ALL, ["coordination.k8s.io"], ["leases"]), rule(READ, ALL, ALL)], { labels: BOOTSTRAP }),
    clusterRole("system:controller:deployment-controller", [rule([...READ, "update"], ["apps", "extensions"], ["deployments"]), rule([...READ, "create", "delete", "patch", "update"], ["apps"], ["replicasets"])], { labels: BOOTSTRAP }),
    clusterRole("system:controller:replicaset-controller", [rule([...READ, "update"], ["apps"], ["replicasets"]), rule(["list", "watch", "patch", "create", "delete"], [""], ["pods"])], { labels: BOOTSTRAP }),
  ];

  const clusterRoleBindings: BindingObject[] = [
    crb("cluster-admin", "cluster-admin", [group("system:masters")], 210, BOOTSTRAP),
    crb("platform-admins", "cluster-admin", [group("acme:platform"), user("jeroen@acme.dev")], 180),
    crb("developers-read-only", "view", [group("acme:developers")], 160),
    crb("developers-rbac-reader", "acme:rbac-reader", [group("acme:developers"), group("acme:security")], 60),
    crb("developers-node-reader", "acme:node-reader", [group("acme:developers")], 45),
    crb("prometheus", "prometheus", [sa("monitoring", "prometheus")], 88),
    crb("cert-manager-controller", "cert-manager-controller", [sa("cert-manager", "cert-manager")], 120),
    crb("system:discovery", "system:discovery", [group("system:authenticated")], 210, BOOTSTRAP),
    crb("system:basic-user", "system:basic-user", [group("system:authenticated")], 210, BOOTSTRAP),
    crb("system:public-info-viewer", "system:public-info-viewer", [group("system:authenticated"), group("system:unauthenticated")], 210, BOOTSTRAP),
    crb("system:kube-scheduler", "system:kube-scheduler", [user("system:kube-scheduler")], 210, BOOTSTRAP),
    crb("system:kube-controller-manager", "system:kube-controller-manager", [user("system:kube-controller-manager")], 210, BOOTSTRAP),
    crb("system:controller:deployment-controller", "system:controller:deployment-controller", [sa("kube-system", "deployment-controller")], 210, BOOTSTRAP),
    crb("system:controller:replicaset-controller", "system:controller:replicaset-controller", [sa("kube-system", "replicaset-controller")], 210, BOOTSTRAP),
  ];

  const roles: RoleObject[] = [
    role("payments", "payments-api", [
      rule(["get", "watch"], [""], ["configmaps"], ["payments-api-config"]),
      rule(["get"], [""], ["secrets"], ["postgres-credentials", "api-acme-dev-tls"]),
      rule(["get", "update"], ["coordination.k8s.io"], ["leases"], ["payments-api-leader"]),
      rule(["create"], ["coordination.k8s.io"], ["leases"]),
    ]),
    role("monitoring", "grafana-sidecar", [rule(READ, [""], ALL)], 88),
    role("kube-system", "extension-apiserver-authentication-reader", [rule(READ, [""], ["configmaps"], ["extension-apiserver-authentication"])], 210),
  ];

  const roleBindings: BindingObject[] = [
    rb("payments", "payments-team-admin", "ClusterRole", "admin", [group("acme:payments-team"), user("lars@acme.dev")], 150),
    rb("checkout", "checkout-team-admin", "ClusterRole", "admin", [group("acme:checkout-team")], 150),
    rb("payments", "ci-deploy", "ClusterRole", "ci-deployer", [sa("platform", "ci-deployer")], 30),
    rb("checkout", "ci-deploy", "ClusterRole", "ci-deployer", [sa("platform", "ci-deployer")], 30),
    rb("payments", "payments-api", "Role", "payments-api", [{ kind: "ServiceAccount", name: "payments-api" }], 41),
    rb("checkout", "contractors-edit", "ClusterRole", "edit", [group("partner:contractors")], 12),
    rb("monitoring", "grafana-sidecar", "Role", "grafana-sidecar", [sa("monitoring", "grafana")], 88),
    rb("checkout", "legacy-release-manager", "Role", "release-manager", [user("jonas@acme.dev")], 400),
    rb("kube-system", "metrics-server-auth-reader", "Role", "extension-apiserver-authentication-reader", [sa("kube-system", "metrics-server")], 210),
  ];

  if (!full) {
    return {
      clusterRoles,
      clusterRoleBindings: clusterRoleBindings.filter((b) => !["prometheus", "cert-manager-controller"].includes(b.metadata.name)),
      roles: [],
      roleBindings: roleBindings.filter((b) => ["payments", "checkout"].includes(b.metadata.namespace ?? "") && b.metadata.name !== "legacy-release-manager"),
    };
  }
  return { clusterRoles, clusterRoleBindings, roles, roleBindings };
}

type Named = { metadata?: { name?: string; namespace?: string } };

const snapshots: Record<string, RbacSnapshot> = {};
for (const [i, context] of CONTEXTS.entries()) {
  const snapshot = buildRbac(i === 0);
  snapshots[context.name] = snapshot;
  // The lists and watches of the app's tables serve them too.
  const cluster = CLUSTERS[context.name];
  cluster.clusterroles = snapshot.clusterRoles;
  cluster.clusterrolebindings = snapshot.clusterRoleBindings;
  cluster.roles = snapshot.roles;
  cluster.rolebindings = snapshot.roleBindings;
  const accounts = (cluster.serviceaccounts = cluster.serviceaccounts || []);
  for (const [namespace, name] of [["platform", "ci-deployer"], ["monitoring", "prometheus"], ["cert-manager", "cert-manager"]]) {
    if (!accounts.some((a: Named) => a.metadata?.namespace === namespace && a.metadata?.name === name)) {
      accounts.push({ apiVersion: "v1", kind: "ServiceAccount", metadata: meta(name, namespace, { age: 30 }) });
    }
  }
}

const snapshotOf = (context: string) => snapshots[context] ?? snapshots[CONTEXTS[0].name];

/* Like the RBAC authorizer: the first binding → rule that allows it, as its reason. */
function decide(context: string, request: AccessRequest & { namespace?: string }) {
  const index = indexRbac(snapshotOf(context));
  for (const grant of grantsFor(index, ME)) {
    if (!grant.role) continue;
    if (grant.namespace !== null && ("path" in request || grant.namespace !== request.namespace)) continue;
    if (!(grant.role.rules ?? []).some((r) => ruleAllows(r, request))) continue;
    const binding = grant.binding;
    const bindingName = binding.kind === "RoleBinding" ? `${binding.metadata.name}/${binding.metadata.namespace}` : binding.metadata.name;
    const subject = grant.subject.kind === "ServiceAccount" ? `${grant.subject.name}/${grant.subject.namespace}` : grant.subject.name;
    return {
      allowed: true,
      reason: `RBAC: allowed by ${binding.kind} "${bindingName}" of ${binding.roleRef.kind} "${binding.roleRef.name}" to ${grant.subject.kind} "${subject}"`,
    };
  }
  return { allowed: false, reason: "" };
}

function rulesIn(context: string, namespace: string) {
  const index = indexRbac(snapshotOf(context));
  const resourceRules: PolicyRule[] = [];
  const nonResourceRules: PolicyRule[] = [];
  for (const grant of grantsFor(index, ME)) {
    if (!grant.role || (grant.namespace !== null && grant.namespace !== namespace)) continue;
    for (const r of grant.role.rules ?? []) {
      if (isNonResourceRule(r)) {
        if (grant.namespace === null) nonResourceRules.push({ verbs: r.verbs, nonResourceURLs: r.nonResourceURLs });
      } else {
        resourceRules.push({ verbs: r.verbs, apiGroups: r.apiGroups, resources: r.resources, ...(r.resourceNames?.length ? { resourceNames: r.resourceNames } : {}) });
      }
    }
  }
  return { resourceRules, nonResourceRules, incomplete: false };
}

const RBAC_PLURALS: Record<string, keyof RbacSnapshot> = {
  clusterroles: "clusterRoles",
  clusterrolebindings: "clusterRoleBindings",
  roles: "roles",
  rolebindings: "roleBindings",
};

/* Like the API: list items without kind and apiVersion. */
const strip = (object: RoleObject | BindingObject) => {
  const copy: Partial<RoleObject | BindingObject> = { ...object };
  delete copy.kind;
  delete copy.apiVersion;
  return copy;
};

registerKubeRoutes([
  {
    method: "GET",
    path: /^\/apis\/rbac\.authorization\.k8s\.io\/v1\/(?:namespaces\/([^/]+)\/)?(clusterroles|clusterrolebindings|roles|rolebindings)$/,
    handle: (request, [, namespace, plural]) => {
      if (!decide(request.context, { verb: "list", group: "rbac.authorization.k8s.io", resource: plural, namespace }).allowed) {
        throw kubeError(
          403,
          `${plural}.rbac.authorization.k8s.io is forbidden: User "${ME.username}" cannot list resource "${plural}" in API group "rbac.authorization.k8s.io" ${namespace ? `in the namespace "${namespace}"` : "at the cluster scope"}`,
          "Forbidden"
        );
      }
      const items = (snapshotOf(request.context)[RBAC_PLURALS[plural]] as (RoleObject | BindingObject)[]).filter(
        (item) => !namespace || item.metadata.namespace === namespace
      );
      return { kind: "List", apiVersion: "rbac.authorization.k8s.io/v1", metadata: { resourceVersion: "4800" }, items: items.map(strip) };
    },
  },
  {
    method: "POST",
    path: /^\/apis\/authorization\.k8s\.io\/v1\/selfsubjectaccessreviews$/,
    handle: (request) => {
      const spec = request.body?.spec ?? {};
      const attributes = spec.nonResourceAttributes
        ? { verb: spec.nonResourceAttributes.verb, path: spec.nonResourceAttributes.path }
        : {
            verb: spec.resourceAttributes?.verb ?? "",
            group: spec.resourceAttributes?.group ?? "",
            resource: spec.resourceAttributes?.resource ?? "",
            subresource: spec.resourceAttributes?.subresource,
            name: spec.resourceAttributes?.name,
            namespace: spec.resourceAttributes?.namespace,
          };
      // ?scenario=gitops-namespaced: Flux and Argo CD objects are readable
      // in their controllers' namespaces only (a team role).
      if (namespacedGitops && /fluxcd\.io$|^argoproj\.io$/.test(attributes.group ?? "") && attributes.verb === "list") {
        return { ...request.body, status: { allowed: ["argocd", "flux-system"].includes(attributes.namespace ?? "") } };
      }
      return { ...request.body, status: decide(request.context, attributes) };
    },
  },
  {
    method: "POST",
    path: /^\/apis\/authorization\.k8s\.io\/v1\/selfsubjectrulesreviews$/,
    handle: (request) => ({ ...request.body, status: rulesIn(request.context, request.body?.spec?.namespace ?? "default") }),
  },
  {
    method: "POST",
    path: /^\/apis\/authentication\.k8s\.io\/v1\/selfsubjectreviews$/,
    handle: (request) => ({ ...request.body, status: { userInfo: { username: ME.username, groups: ME.groups } } }),
  },
  {
    method: "GET",
    path: /^\/api\/v1\/namespaces\/([^/]+)\/pods$/,
    handle: (request, [, namespace]) => {
      const account = (request.query.get("fieldSelector") ?? "").match(/spec\.serviceAccountName=(.+)/)?.[1];
      const pods = (CLUSTERS[request.context]?.pods ?? []).filter(
        (pod: Named & { spec?: { serviceAccountName?: string } }) => pod.metadata?.namespace === namespace && (!account || (pod.spec?.serviceAccountName ?? "default") === account)
      );
      return { kind: "PodList", apiVersion: "v1", items: pods };
    },
  },
]);
