import { describe, expect, test } from "vitest";
import {
  contextKey,
  isSameContext,
  matchesFilter,
  parseContextKey,
  toggleNamespaceSelection,
} from "@/lib/contextKey";

describe("contextKey", () => {
  test("distinguishes equally named contexts of different kubeconfigs", () => {
    const a = contextKey("kind-kind", "/home/me/.kube/config");
    const b = contextKey("kind-kind", "/home/me/.kube/other");
    expect(a).not.toEqual(b);
  });

  test("round-trips through parseContextKey", () => {
    const key = contextKey("arn:aws:eks:eu-west-1:1:cluster/x", "/k/config");
    expect(parseContextKey(key)).toEqual({
      context: "arn:aws:eks:eu-west-1:1:cluster/x",
      kubeConfig: "/k/config",
    });
  });

  test("parses a legacy name-only key", () => {
    expect(parseContextKey("default")).toEqual({
      context: "default",
      kubeConfig: "",
    });
  });
});

describe("isSameContext", () => {
  test("requires matching kubeconfigs when both are known", () => {
    expect(
      isSameContext(
        { context: "default", kubeConfig: "/a" },
        { context: "default", kubeConfig: "/b" }
      )
    ).toBe(false);
    expect(
      isSameContext(
        { context: "default", kubeConfig: "/a" },
        { context: "default", kubeConfig: "/a" }
      )
    ).toBe(true);
  });

  test("treats an unknown kubeconfig as a wildcard", () => {
    expect(
      isSameContext(
        { context: "default", kubeConfig: "" },
        { context: "default", kubeConfig: "/b" }
      )
    ).toBe(true);
    expect(
      isSameContext(
        { context: "default", kubeConfig: "" },
        { context: "other", kubeConfig: "" }
      )
    ).toBe(false);
  });
});

describe("toggleNamespaceSelection", () => {
  const available = ["a", "b", "c"];

  test("toggles all namespaces on and off", () => {
    expect(toggleNamespaceSelection([], available, "all")).toEqual(["all"]);
    expect(toggleNamespaceSelection(["all"], available, "all")).toEqual([]);
  });

  test("expands 'all' before deselecting a single namespace", () => {
    expect(toggleNamespaceSelection(["all"], available, "b")).toEqual([
      "a",
      "c",
    ]);
  });

  test("adds and removes single namespaces", () => {
    expect(toggleNamespaceSelection(["a"], available, "b")).toEqual(["a", "b"]);
    expect(toggleNamespaceSelection(["a", "b"], available, "a")).toEqual(["b"]);
    expect(toggleNamespaceSelection(["a"], available, "a")).toEqual([]);
  });

  test("folds a complete selection back to 'all'", () => {
    expect(toggleNamespaceSelection(["a", "b"], available, "c")).toEqual([
      "all",
    ]);
  });
});

describe("matchesFilter", () => {
  test("is case-insensitive and ignores surrounding whitespace", () => {
    expect(matchesFilter("Kube-System", " kube ")).toBe(true);
    expect(matchesFilter("default", "")).toBe(true);
    expect(matchesFilter("default", "prod")).toBe(false);
  });
});
