import { describe, expect, test } from "vitest";
import { apiPath, queryString, serviceProxyPath } from "@/lib/kubeApi";

describe("apiPath", () => {
  test("builds core and group paths", () => {
    expect(apiPath({ apiVersion: "v1", resource: "nodes", name: "a" })).toBe("/api/v1/nodes/a");
    expect(
      apiPath({
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        resource: "kustomizations",
        namespace: "flux-system",
        name: "apps",
      })
    ).toBe("/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps");
  });

  test("adds subresources and queries", () => {
    expect(
      apiPath({
        apiVersion: "apps/v1",
        resource: "deployments",
        namespace: "a",
        name: "b",
        subresource: "scale",
        query: { fieldManager: "jet-pilot", dryRun: undefined },
      })
    ).toBe("/apis/apps/v1/namespaces/a/deployments/b/scale?fieldManager=jet-pilot");
  });

  test("escapes names", () => {
    expect(apiPath({ apiVersion: "v1", resource: "pods", namespace: "a b", name: "c/d" })).toBe(
      "/api/v1/namespaces/a%20b/pods/c%2Fd"
    );
  });
});

describe("serviceProxyPath", () => {
  test("proxies to a named or numbered port", () => {
    expect(
      serviceProxyPath({ namespace: "monitoring", service: "prometheus", port: 9090 }, "/api/v1/query?query=up")
    ).toBe("/api/v1/namespaces/monitoring/services/http:prometheus:9090/proxy/api/v1/query?query=up");
    expect(
      serviceProxyPath({ namespace: "m", service: "vm", port: "web", scheme: "https" }, "api/v1/labels")
    ).toBe("/api/v1/namespaces/m/services/https:vm:web/proxy/api/v1/labels");
  });

  test("query strings skip undefined values", () => {
    expect(queryString({ a: 1, b: undefined, c: true })).toBe("?a=1&c=true");
    expect(queryString({})).toBe("");
  });
});
