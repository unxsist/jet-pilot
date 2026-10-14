import { describe, expect, test } from "vitest";
import { workloadsOf } from "@/lib/accessReview";
import {
  EVERY_NAMESPACE,
  URL_RESOURCE,
  parseResourceValue,
  questionText,
  requestOf,
  resourceOptions,
  resourceValue,
  subresourceOptions,
  type Question,
} from "@/components/rbac/question";
import { subjectHint } from "@/lib/rbac";

const question = (patch: Partial<Question>): Question => ({
  verb: "list",
  resource: "pods",
  namespace: "payments",
  name: "",
  subresource: "",
  path: "",
  ...patch,
});

describe("questions", () => {
  test("resource values in kubectl's style", () => {
    expect(resourceValue({ name: "deployments", group: "apps" })).toBe("deployments.apps");
    expect(parseResourceValue("rolebindings.rbac.authorization.k8s.io")).toEqual({
      resource: "rolebindings",
      group: "rbac.authorization.k8s.io",
    });
    expect(parseResourceValue("pods")).toEqual({ resource: "pods", group: "" });
  });

  test("turn into access requests", () => {
    expect(requestOf(question({ resource: "deployments.apps", subresource: "scale", verb: "patch" }), true)).toEqual({
      verb: "patch",
      group: "apps",
      resource: "deployments",
      subresource: "scale",
      namespace: "payments",
    });
    // Every namespace, or a cluster-scoped resource: no namespace.
    expect(requestOf(question({ namespace: EVERY_NAMESPACE }), true)).toEqual({ verb: "list", group: "", resource: "pods" });
    expect(requestOf(question({ resource: "nodes" }), false)).toEqual({ verb: "list", group: "", resource: "nodes" });
    expect(requestOf(question({ resource: URL_RESOURCE, verb: "get", path: "/metrics" }), false)).toEqual({
      verb: "get",
      path: "/metrics",
    });
  });

  test("read as text", () => {
    expect(questionText(question({ verb: "create", subresource: "exec" }), true)).toBe("create pods/exec in payments");
    expect(questionText(question({ verb: "get", resource: "secrets", name: "db" }), true)).toBe("get secrets named db in payments");
    expect(questionText(question({ namespace: EVERY_NAMESPACE }), true)).toBe("list pods in every namespace");
    expect(questionText(question({ resource: "nodes", verb: "*" }), false)).toBe("do anything with nodes");
  });

  test("options from discovery", () => {
    const resources = [
      { name: "widgets", kind: "Widget", namespaced: true, group: "acme.dev", version: "v1", verbs: [] },
      { name: "pods", kind: "Pod", namespaced: true, group: "", version: "v1", verbs: [], shortNames: ["po"] },
    ];
    const options = resourceOptions(resources);
    expect(options.map((o) => o.value)).toEqual(["pods", "widgets.acme.dev", URL_RESOURCE]);
    expect(options[0].keywords).toContain("po");
    const snapshot = {
      context: "c",
      kubeConfig: "",
      fetchedAt: 0,
      groups: { v1: [...resources.slice(1), { ...resources[1], name: "pods/log" }, { ...resources[1], name: "pods/exec" }] },
    };
    expect(subresourceOptions(snapshot, "pods", "").map((o) => o.value)).toEqual(["exec", "log"]);
  });

  test("subject hints only when they say something", () => {
    expect(subjectHint({ kind: "User", name: "a" })).toBe("");
    expect(subjectHint({ kind: "Group", name: "team" })).toBe("");
    expect(subjectHint({ kind: "Group", name: "system:authenticated" })).toBe("Everyone who's signed in");
  });
});

describe("workloads of pods", () => {
  test("ReplicaSets resolve to their Deployment", () => {
    const pod = (name: string, owner?: { kind: string; name: string }, hash?: string) => ({
      metadata: {
        name,
        namespace: "payments",
        labels: hash ? { "pod-template-hash": hash } : {},
        ownerReferences: owner ? [{ ...owner, controller: true }] : [],
      },
    });
    expect(
      workloadsOf([
        pod("api-7c9-a", { kind: "ReplicaSet", name: "api-7c9" }, "7c9"),
        pod("api-7c9-b", { kind: "ReplicaSet", name: "api-7c9" }, "7c9"),
        pod("db-0", { kind: "StatefulSet", name: "db" }),
        pod("debug"),
      ])
    ).toEqual([
      { kind: "Deployment", name: "api", namespace: "payments", pods: 2 },
      { kind: "Pod", name: "debug", namespace: "payments", pods: 1 },
      { kind: "StatefulSet", name: "db", namespace: "payments", pods: 1 },
    ]);
  });
});
