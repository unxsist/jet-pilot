import { describe, expect, test } from "vitest";
import {
  type BindingObject,
  type PolicyRule,
  type RbacSnapshot,
  type RoleObject,
  aggregatedFrom,
  aggregatesInto,
  bindingsOfRole,
  danglingBindings,
  effectivePermissions,
  grantsFor,
  identityOf,
  indexRbac,
  isFullAccess,
  matchesSelector,
  matchingRule,
  otherVerbs,
  parseAllowReason,
  parseSubjectKey,
  permissionMatrix,
  rowGrants,
  ruleAllows,
  ruleSummary,
  sourcesOfVerb,
  subjectDescription,
  subjectKey,
  subjectsOf,
  verbPhrase,
  whoCan,
  wildcardSummary,
} from "@/lib/rbac";

const clusterRole = (name: string, rules: PolicyRule[], extra: Partial<RoleObject> = {}): RoleObject => ({
  kind: "ClusterRole",
  metadata: { name },
  rules,
  ...extra,
});
const role = (namespace: string, name: string, rules: PolicyRule[]): RoleObject => ({
  kind: "Role",
  metadata: { name, namespace },
  rules,
});
const crb = (name: string, roleName: string, subjects: BindingObject["subjects"]): BindingObject => ({
  kind: "ClusterRoleBinding",
  metadata: { name },
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: roleName },
  subjects,
});
const rb = (
  namespace: string,
  name: string,
  roleRef: BindingObject["roleRef"],
  subjects: BindingObject["subjects"]
): BindingObject => ({ kind: "RoleBinding", metadata: { name, namespace }, roleRef, subjects });

const ALL: PolicyRule = { verbs: ["*"], apiGroups: ["*"], resources: ["*"] };
const READ_PODS: PolicyRule = { verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods", "pods/log"] };

const snapshot: RbacSnapshot = {
  clusterRoles: [
    clusterRole("cluster-admin", [ALL, { verbs: ["*"], nonResourceURLs: ["*"] }]),
    clusterRole("admin", [
      { verbs: ["*"], apiGroups: ["", "apps"], resources: ["*"] },
    ]),
    clusterRole("view", [READ_PODS, { verbs: ["get", "list", "watch"], apiGroups: ["apps"], resources: ["deployments"] }]),
    clusterRole(
      "monitoring",
      [{ verbs: ["get", "list"], apiGroups: ["monitoring.coreos.com"], resources: ["prometheuses"] }],
      { aggregationRule: { clusterRoleSelectors: [{ matchLabels: { "acme.dev/aggregate-to-monitoring": "true" } }] } }
    ),
    clusterRole("monitoring-extra", [{ verbs: ["get"], apiGroups: [""], resources: ["nodes"] }], {
      metadata: { name: "monitoring-extra", labels: { "acme.dev/aggregate-to-monitoring": "true" } },
    }),
    clusterRole("metrics-reader", [{ verbs: ["get"], nonResourceURLs: ["/metrics", "/debug/*"] }]),
  ],
  roles: [
    role("ci", "deployer", [
      { verbs: ["get", "list", "update", "patch"], apiGroups: ["apps"], resources: ["deployments", "deployments/scale"] },
      { verbs: ["get"], apiGroups: [""], resources: ["secrets"], resourceNames: ["registry-token"] },
    ]),
  ],
  clusterRoleBindings: [
    crb("platform-admins", "cluster-admin", [{ kind: "Group", name: "platform-team" }]),
    crb("readers", "view", [{ kind: "Group", name: "system:authenticated" }]),
    crb("metrics", "metrics-reader", [{ kind: "ServiceAccount", name: "prometheus", namespace: "monitoring" }]),
    crb("ghost", "does-not-exist", [{ kind: "User", name: "old@acme.dev" }]),
  ],
  roleBindings: [
    rb("payments", "payments-admins", { kind: "ClusterRole", name: "admin" }, [
      { kind: "Group", name: "payments-team" },
      { kind: "User", name: "alice@acme.dev" },
    ]),
    // A service account without a namespace defaults to the binding's.
    rb("ci", "deployers", { kind: "Role", name: "deployer" }, [{ kind: "ServiceAccount", name: "deployer" }]),
    rb("checkout", "all-sa", { kind: "ClusterRole", name: "admin" }, [
      { kind: "Group", name: "system:serviceaccounts:ci" },
    ]),
    rb("payments", "missing-role", { kind: "Role", name: "gone" }, [{ kind: "User", name: "bob@acme.dev" }]),
  ],
};
const index = indexRbac(snapshot);

describe("rule matching", () => {
  test("verbs, groups and resources, with wildcards", () => {
    expect(ruleAllows(READ_PODS, { verb: "list", group: "", resource: "pods" })).toBe(true);
    expect(ruleAllows(READ_PODS, { verb: "delete", group: "", resource: "pods" })).toBe(false);
    expect(ruleAllows(READ_PODS, { verb: "list", group: "apps", resource: "pods" })).toBe(false);
    expect(ruleAllows(ALL, { verb: "escalate", group: "rbac.authorization.k8s.io", resource: "clusterroles" })).toBe(true);
  });

  test("subresources match exactly or through */subresource", () => {
    expect(ruleAllows(READ_PODS, { verb: "get", group: "", resource: "pods", subresource: "log" })).toBe(true);
    expect(ruleAllows(READ_PODS, { verb: "get", group: "", resource: "pods", subresource: "exec" })).toBe(false);
    const scale: PolicyRule = { verbs: ["update"], apiGroups: ["*"], resources: ["*/scale"] };
    expect(ruleAllows(scale, { verb: "update", group: "apps", resource: "deployments", subresource: "scale" })).toBe(true);
    expect(ruleAllows(scale, { verb: "update", group: "apps", resource: "deployments" })).toBe(false);
    // `pods/*` is not a wildcard in RBAC.
    const podsStar: PolicyRule = { verbs: ["get"], apiGroups: [""], resources: ["pods/*"] };
    expect(ruleAllows(podsStar, { verb: "get", group: "", resource: "pods", subresource: "log" })).toBe(false);
  });

  test("resourceNames only match requests for those names", () => {
    const rule = snapshot.roles[0].rules![1];
    expect(ruleAllows(rule, { verb: "get", group: "", resource: "secrets", name: "registry-token" })).toBe(true);
    expect(ruleAllows(rule, { verb: "get", group: "", resource: "secrets", name: "db-password" })).toBe(false);
    expect(ruleAllows(rule, { verb: "get", group: "", resource: "secrets" })).toBe(false);
  });

  test("nonResourceURLs, with a trailing * prefix", () => {
    const rule = snapshot.clusterRoles.find((r) => r.metadata.name === "metrics-reader")!.rules![0];
    expect(ruleAllows(rule, { verb: "get", path: "/metrics" })).toBe(true);
    expect(ruleAllows(rule, { verb: "get", path: "/debug/pprof/heap" })).toBe(true);
    expect(ruleAllows(rule, { verb: "get", path: "/healthz" })).toBe(false);
    expect(ruleAllows(rule, { verb: "post", path: "/metrics" })).toBe(false);
    // A resource rule never matches a non-resource request.
    expect(ruleAllows(READ_PODS, { verb: "get", path: "/metrics" })).toBe(false);
  });

  test("prefers exact rules over wildcard ones", () => {
    const r = clusterRole("mixed", [ALL, READ_PODS]);
    expect(matchingRule(r, { verb: "get", group: "", resource: "pods" })?.index).toBe(1);
    expect(matchingRule(r, { verb: "delete", group: "", resource: "pods" })?.index).toBe(0);
  });

  test("full access", () => {
    expect(isFullAccess(ALL)).toBe(true);
    expect(isFullAccess({ ...ALL, resourceNames: ["x"] })).toBe(false);
    expect(isFullAccess(snapshot.clusterRoles[1].rules![0])).toBe(false);
  });

  test("label selectors", () => {
    expect(matchesSelector({ a: "1" }, { matchLabels: { a: "1" } })).toBe(true);
    expect(matchesSelector({ a: "1" }, { matchLabels: { a: "2" } })).toBe(false);
    expect(matchesSelector({ a: "1" }, { matchExpressions: [{ key: "a", operator: "In", values: ["1", "2"] }] })).toBe(true);
    expect(matchesSelector({}, { matchExpressions: [{ key: "a", operator: "DoesNotExist" }] })).toBe(true);
    expect(matchesSelector({ a: "1" }, { matchExpressions: [{ key: "a", operator: "NotIn", values: ["1"] }] })).toBe(false);
  });
});

describe("subjects", () => {
  test("service accounts belong to the implicit groups", () => {
    expect(identityOf({ kind: "ServiceAccount", name: "deployer", namespace: "ci" })).toEqual({
      username: "system:serviceaccount:ci:deployer",
      groups: ["system:serviceaccounts", "system:serviceaccounts:ci", "system:authenticated"],
    });
    expect(identityOf({ kind: "User", name: "alice@acme.dev" }).groups).toEqual(["system:authenticated"]);
  });

  test("keys round-trip", () => {
    const sa = { kind: "ServiceAccount" as const, name: "deployer", namespace: "ci" };
    expect(parseSubjectKey(subjectKey(sa))).toEqual(sa);
    expect(parseSubjectKey(subjectKey({ kind: "User", name: "a:b@c" }))).toEqual({ kind: "User", name: "a:b@c" });
  });

  test("describes well-known groups", () => {
    expect(subjectDescription({ kind: "Group", name: "system:authenticated" })).toBe("Everyone who's signed in");
    expect(subjectDescription({ kind: "Group", name: "system:serviceaccounts:ci" })).toBe("Every service account in ci");
    expect(subjectDescription({ kind: "ServiceAccount", name: "x", namespace: "ci" })).toBe("Service account in ci");
  });

  test("lists the subjects of every binding", () => {
    const subjects = subjectsOf(index);
    expect(subjects.map((s) => s.key)).toContain("ServiceAccount:ci:deployer");
    expect(subjects.find((s) => s.subject.name === "system:authenticated")?.system).toBe(true);
    expect(subjects[0].subject.kind).toBe("User");
  });
});

describe("who can", () => {
  const names = (list: ReturnType<typeof whoCan>) => list.map((s) => s.subject.name);

  test("a ClusterRole bound by a RoleBinding only grants in that namespace", () => {
    const deleteInPayments = whoCan(index, { verb: "delete", group: "apps", resource: "deployments", namespace: "payments" }, { namespace: "payments" });
    expect(names(deleteInPayments)).toEqual(["alice@acme.dev", "payments-team", "platform-team"]);
    const deleteInCheckout = whoCan(index, { verb: "delete", group: "apps", resource: "deployments" }, { namespace: "checkout" });
    expect(names(deleteInCheckout)).toEqual(["platform-team", "system:serviceaccounts:ci"]);
  });

  test("anywhere: every namespace, each grant saying where", () => {
    const result = whoCan(index, { verb: "delete", group: "apps", resource: "deployments" }, "anywhere");
    const team = result.find((s) => s.subject.name === "payments-team")!;
    expect(team.everywhere).toBe(false);
    expect(team.namespaces).toEqual(["payments"]);
    const admins = result.find((s) => s.subject.name === "platform-team")!;
    expect(admins.everywhere).toBe(true);
    expect(admins.grants[0].fullAccess).toBe(true);
    expect(admins.grants[0].wildcard).toBe(true);
  });

  test("cluster scope leaves RoleBindings out", () => {
    expect(names(whoCan(index, { verb: "delete", group: "apps", resource: "deployments" }, "cluster"))).toEqual(["platform-team"]);
  });

  test("explains the chain and defaults service account namespaces", () => {
    const result = whoCan(index, { verb: "patch", group: "apps", resource: "deployments", subresource: "scale" }, { namespace: "ci" });
    const deployer = result.find((s) => s.subject.kind === "ServiceAccount")!;
    expect(deployer.subject).toEqual({ kind: "ServiceAccount", name: "deployer", namespace: "ci" });
    expect(deployer.grants[0].binding.metadata.name).toBe("deployers");
    expect(deployer.grants[0].role.metadata.name).toBe("deployer");
    expect(deployer.grants[0].ruleIndex).toBe(0);
    expect(deployer.grants[0].wildcard).toBe(false);
  });

  test("system subjects sort last", () => {
    const result = whoCan(index, { verb: "list", group: "", resource: "pods" }, { namespace: "payments" });
    expect(result[result.length - 1].subject.name).toBe("system:authenticated");
    expect(result[result.length - 1].system).toBe(true);
  });

  test("non-resource URLs: ClusterRoleBindings only", () => {
    expect(names(whoCan(index, { verb: "get", path: "/metrics" }, "anywhere"))).toEqual(["platform-team", "prometheus"]);
  });

  test("dangling bindings grant nothing", () => {
    const result = whoCan(index, { verb: "get", group: "", resource: "pods" }, "anywhere");
    expect(names(result)).not.toContain("old@acme.dev");
    expect(danglingBindings(index).map((b) => b.metadata.name)).toEqual(["ghost", "missing-role"]);
  });
});

describe("what a subject can do", () => {
  test("service accounts get grants through their implicit groups", () => {
    const grants = grantsFor(index, identityOf({ kind: "ServiceAccount", name: "deployer", namespace: "ci" }));
    expect(grants.map((g) => [g.binding.metadata.name, g.viaGroup ?? "direct", g.namespace])).toEqual([
      ["readers", "system:authenticated", null],
      ["deployers", "direct", "ci"],
      ["all-sa", "system:serviceaccounts:ci", "checkout"],
    ]);
  });

  test("splits everywhere and per namespace; dangling refs apart", () => {
    const bob = effectivePermissions(index, identityOf({ kind: "User", name: "bob@acme.dev" }));
    expect(bob.dangling.map((g) => g.binding.metadata.name)).toEqual(["missing-role"]);
    expect(bob.everywhere).toHaveLength(2); // view, through system:authenticated
    const deployer = effectivePermissions(index, identityOf({ kind: "ServiceAccount", name: "deployer", namespace: "ci" }));
    expect([...deployer.namespaces.keys()]).toEqual(["checkout", "ci"]);
  });

  test("RoleBindings don't grant non-resource URLs", () => {
    const sa = { kind: "ServiceAccount" as const, name: "x", namespace: "ns" };
    const local = indexRbac({
      ...snapshot,
      clusterRoleBindings: [],
      roleBindings: [rb("ns", "local", { kind: "ClusterRole", name: "metrics-reader" }, [sa])],
    });
    expect(effectivePermissions(local, identityOf(sa)).namespaces.get("ns")).toEqual([]);
  });

  test("RoleBindings don't grant cluster-scoped resources (when discovery knows them)", () => {
    const sa = { kind: "ServiceAccount" as const, name: "x", namespace: "ns" };
    const local = indexRbac({
      ...snapshot,
      clusterRoles: [
        clusterRole("mixed", [
          { verbs: ["get"], apiGroups: [""], resources: ["nodes", "pods", "nodes/proxy", "widgets"] },
          { verbs: ["list"], apiGroups: ["apiextensions.k8s.io"], resources: ["customresourcedefinitions"] },
          { verbs: ["get"], apiGroups: ["*"], resources: ["nodes"] },
          { verbs: ["*"], apiGroups: [""], resources: ["*"] },
        ]),
      ],
      clusterRoleBindings: [crb("everywhere", "mixed", [{ kind: "User", name: "admin" }])],
      roleBindings: [rb("ns", "local", { kind: "ClusterRole", name: "mixed" }, [sa])],
    });
    const CLUSTER_SCOPED = new Set(["/nodes", "apiextensions.k8s.io/customresourcedefinitions"]);
    const NAMESPACED = new Set(["/pods"]);
    const namespaced = (group: string, resource: string) =>
      CLUSTER_SCOPED.has(`${group}/${resource}`) ? false : NAMESPACED.has(`${group}/${resource}`) ? true : undefined;

    expect(effectivePermissions(local, identityOf(sa), namespaced).namespaces.get("ns")!.map((r) => r.rule)).toEqual([
      // Unknown (widgets), wildcard groups and `*` resources stay.
      { verbs: ["get"], apiGroups: [""], resources: ["pods", "widgets"] },
      { verbs: ["get"], apiGroups: ["*"], resources: ["nodes"] },
      { verbs: ["*"], apiGroups: [""], resources: ["*"] },
    ]);
    // Without discovery nothing is dropped; ClusterRoleBindings keep everything.
    expect(effectivePermissions(local, identityOf(sa)).namespaces.get("ns")).toHaveLength(4);
    expect(effectivePermissions(local, identityOf({ kind: "User", name: "admin" }), namespaced).everywhere).toHaveLength(4);
  });

  test("bindings of a role", () => {
    const admin = index.clusterRole("admin")!;
    expect(bindingsOfRole(index, admin).map((b) => b.metadata.name)).toEqual(["payments-admins", "all-sa"]);
    expect(bindingsOfRole(index, index.role("ci", "deployer")!).map((b) => b.metadata.name)).toEqual(["deployers"]);
  });

  test("aggregation", () => {
    const monitoring = index.clusterRole("monitoring")!;
    const extra = index.clusterRole("monitoring-extra")!;
    expect(aggregatedFrom(index, monitoring)).toEqual([extra]);
    expect(aggregatesInto(index, extra)).toEqual([monitoring]);
    expect(aggregatedFrom(index, extra)).toEqual([]);
  });
});

describe("matrix", () => {
  test("rows per group and resource, merged, with sources", () => {
    const matrix = permissionMatrix([
      { rule: READ_PODS, source: "view" },
      { rule: { verbs: ["delete", "deletecollection"], apiGroups: [""], resources: ["pods"] }, source: "cleanup" },
      { rule: { verbs: ["*"], apiGroups: ["apps"], resources: ["*"] }, source: "apps-admin" },
      { rule: { verbs: ["get"], apiGroups: [""], resources: ["secrets"], resourceNames: ["b", "a"] }, source: "one-secret" },
      { rule: { verbs: ["get"], nonResourceURLs: ["/healthz"] }, source: "health" },
    ]);
    expect(matrix.groups.map((g) => g.group)).toEqual(["", "apps"]);
    const core = matrix.groups[0].rows;
    expect(core.map((r) => r.resource)).toEqual(["pods", "pods/log", "secrets"]);
    const pods = core[0];
    expect(rowGrants(pods, "list")).toBe(true);
    expect(rowGrants(pods, "create")).toBe(false);
    expect(otherVerbs(pods)).toEqual(["deletecollection"]);
    expect(sourcesOfVerb(pods, "delete")).toEqual(["cleanup"]);
    expect(core[2].names).toEqual(["a", "b"]);
    const apps = matrix.groups[1].rows[0];
    expect(apps.resource).toBe("*");
    expect(rowGrants(apps, "patch")).toBe(true);
    expect(sourcesOfVerb(apps, "patch")).toEqual(["apps-admin"]);
    expect(matrix.nonResource.map((r) => r.path)).toEqual(["/healthz"]);
    expect(matrix.fullAccess).toEqual([]);
    expect(matrix.rowCount).toBe(4);
  });

  test("flags full access", () => {
    expect(permissionMatrix([{ rule: ALL, source: 1 }]).fullAccess).toEqual([1]);
  });
});

describe("words", () => {
  test("verb phrases", () => {
    expect(verbPhrase(["get", "list", "watch"])).toBe("read");
    expect(verbPhrase(["get", "list", "watch", "create", "update", "patch", "delete"])).toBe("read and change");
    expect(verbPhrase(["get", "list"])).toBe("get and list");
    expect(verbPhrase(["*"])).toBe("do anything with");
  });

  test("rule summaries", () => {
    expect(ruleSummary(ALL)).toBe("do anything with everything");
    expect(ruleSummary(READ_PODS)).toBe("read pods and pods/log");
    expect(ruleSummary(snapshot.roles[0].rules![1])).toBe("get secrets named registry-token");
    expect(ruleSummary({ verbs: ["get", "list", "watch"], apiGroups: ["apps"], resources: ["deployments"] })).toBe(
      "read deployments (apps)"
    );
    expect(ruleSummary({ verbs: ["get"], nonResourceURLs: ["/metrics", "/healthz"] })).toBe("get /metrics and /healthz");
  });

  test("wildcard summaries", () => {
    expect(wildcardSummary(ALL, { verb: "delete", group: "apps", resource: "deployments" })).toBe(
      "every verb on every resource in every API group"
    );
    expect(wildcardSummary(READ_PODS, { verb: "get", group: "", resource: "pods" })).toBeNull();
    const scale: PolicyRule = { verbs: ["patch"], apiGroups: ["apps"], resources: ["*/scale"] };
    expect(wildcardSummary(scale, { verb: "patch", group: "apps", resource: "deployments", subresource: "scale" })).toBe(
      "patch on the scale of every resource"
    );
    expect(wildcardSummary({ verbs: ["*"], nonResourceURLs: ["/metrics"] }, { verb: "get", path: "/metrics" })).toBe(
      "every verb on /metrics"
    );
  });

  test("parses the RBAC authorizer's reason", () => {
    expect(
      parseAllowReason('RBAC: allowed by RoleBinding "deployers/ci" of Role "deployer" to ServiceAccount "deployer/ci"')
    ).toEqual({
      binding: { kind: "RoleBinding", name: "deployers", namespace: "ci" },
      role: { kind: "Role", name: "deployer" },
      subject: { kind: "ServiceAccount", name: "deployer", namespace: "ci" },
    });
    expect(
      parseAllowReason('RBAC: allowed by ClusterRoleBinding "platform-admins" of ClusterRole "cluster-admin" to Group "platform-team"')
    ).toEqual({
      binding: { kind: "ClusterRoleBinding", name: "platform-admins" },
      role: { kind: "ClusterRole", name: "cluster-admin" },
      subject: { kind: "Group", name: "platform-team" },
    });
    expect(parseAllowReason("allowed by the cloud IAM policy")).toBeNull();
  });
});
