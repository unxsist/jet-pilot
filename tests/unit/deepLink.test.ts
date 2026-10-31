import { describe, expect, it } from "vitest";
import {
  buildLink,
  collapseHome,
  linkKubeConfig,
  matchContext,
  objectLink,
  parseLink,
  type DeepLink,
} from "@/lib/deepLink";

const HOME = "/Users/ana";

describe("building links", () => {
  it("links an object readably, without the default kubeconfig", () => {
    expect(
      buildLink(
        {
          type: "object",
          context: "prod-eu",
          kubeConfig: "/Users/ana/.kube/config",
          kind: "Deployment",
          apiVersion: "apps/v1",
          namespace: "shop",
          name: "checkout-api",
        },
        HOME
      )
    ).toBe("jetpilot://open?context=prod-eu&kind=Deployment&apiVersion=apps/v1&namespace=shop&name=checkout-api");
  });

  it("writes other kubeconfigs from the home directory and escapes what needs it", () => {
    expect(
      buildLink(
        { type: "list", context: "arn:aws:eks:eu-west-1:1234:cluster/prod a", kubeConfig: "/Users/ana/.kube/jet-pilot/config", kind: "Pod" },
        HOME
      )
    ).toBe("jetpilot://list?context=arn:aws:eks:eu-west-1:1234:cluster/prod%20a&kubeconfig=~/.kube/jet-pilot/config&kind=Pod");
    expect(buildLink({ type: "helm", context: "c&d", namespace: "shop", name: "web+api" })).toBe(
      "jetpilot://helm?context=c%26d&namespace=shop&name=web%2Bapi"
    );
    expect(buildLink({ type: "health", tab: "problems" })).toBe("jetpilot://health?tab=problems");
    expect(buildLink({ type: "health" })).toBe("jetpilot://health");
  });

  it("links table rows and panel objects tagged with their cluster", () => {
    const pod = { kind: "Pod", apiVersion: "v1", metadata: { name: "api-1", namespace: "shop", context: "kind", kubeConfig: "" } };
    expect(objectLink(pod)).toBe("jetpilot://open?context=kind&kind=Pod&apiVersion=v1&namespace=shop&name=api-1");
    const node = { kind: "Node", apiVersion: "v1", metadata: { name: "n1", context: "kind", kubeConfig: "C:\\Users\\ana\\kube.yaml" } };
    expect(objectLink(node, "C:\\Users\\ana")).toBe("jetpilot://open?context=kind&kubeconfig=~/kube.yaml&kind=Node&apiVersion=v1&name=n1");
    expect(objectLink({ kind: "Pod", metadata: { name: "x" } })).toBeNull();
    expect(objectLink({ metadata: { name: "x", context: "kind" } })).toBeNull();
  });

  it("round-trips through the parser", () => {
    const links: DeepLink[] = [
      { type: "object", context: "gke_proj_europe-west4_prod", kind: "Certificate", apiVersion: "cert-manager.io/v1", namespace: "edge", name: "wildcard-tls" },
      { type: "object", context: "kind", kubeConfig: "~/work/kube.yaml", kind: "ClusterRole", apiVersion: "rbac.authorization.k8s.io/v1", name: "system:controller:job" },
      { type: "list", context: "prod", kind: "CronJob", apiVersion: "batch/v1beta1" },
      { type: "helm", context: "prod", namespace: "shop", name: "checkout" },
      { type: "health", tab: "risks" },
    ];
    for (const link of links) expect(parseLink(buildLink(link, HOME))).toEqual({ ok: true, link });
  });
});

describe("parsing links", () => {
  it("accepts the scheme in any case and without slashes", () => {
    expect(parseLink("JetPilot:open?context=prod&kind=Pod&name=api")).toEqual({
      ok: true,
      link: { type: "object", context: "prod", kind: "Pod", name: "api" },
    });
    expect(parseLink("  jetpilot://health/  ")).toEqual({ ok: true, link: { type: "health" } });
  });

  it("explains what's missing or wrong in a sentence", () => {
    const reason = (url: string) => {
      const parsed = parseLink(url);
      return parsed.ok ? null : parsed.reason;
    };
    expect(reason("https://example.com")).toBe("This isn't a JET Pilot link.");
    expect(reason("jetpilot://open?kind=Pod&name=x")).toBe("The link doesn't say which cluster.");
    expect(reason("jetpilot://open?context=prod&name=x")).toBe("The link doesn't say which kind of object.");
    expect(reason("jetpilot://open?context=prod&kind=Pod")).toBe("The link doesn't say which object.");
    expect(reason("jetpilot://open?context=prod&kind=Pod;rm&name=x")).toBe('"Pod;rm" isn\'t a kind.');
    expect(reason("jetpilot://open?context=prod&kind=Pod&name=--all")).toBe('"--all" isn\'t a valid name.');
    expect(reason("jetpilot://open?context=prod&kind=Pod&name=x&apiVersion=../v1")).toBe('"../v1" isn\'t an API version.');
    expect(reason("jetpilot://helm?context=prod&name=x")).toBe("The link doesn't say which Helm release.");
    expect(reason("jetpilot://delete?context=prod&kind=Pod&name=x")).toBe(
      "JET Pilot doesn't know this kind of link. It may need a newer version."
    );
    expect(reason("jetpilot://health?tab=Prob lems")).toBe('"Prob lems" isn\'t a Health tab.');
    expect(reason("jetpilot://open?context=a%0Ab&kind=Pod&name=x")).toBe("The link's cluster name isn't valid.");
  });
});

describe("home directories", () => {
  it("collapses and keeps other paths as they are", () => {
    expect(collapseHome("/Users/ana/.kube/config", "/Users/ana/")).toBe("~/.kube/config");
    expect(collapseHome("/Users/anabel/.kube/config", "/Users/ana")).toBe("/Users/anabel/.kube/config");
    expect(collapseHome("/etc/kube.yaml", "")).toBe("/etc/kube.yaml");
    expect(linkKubeConfig("", HOME)).toBeUndefined();
    expect(linkKubeConfig("/Users/ana/.kube/config", HOME)).toBeUndefined();
  });
});

describe("matching a link to a known cluster", () => {
  const known = [
    { context: "prod", kubeConfig: "/home/bo/.kube/config" },
    { context: "prod", kubeConfig: "/home/bo/.kube/jet-pilot/config" },
    { context: "staging", kubeConfig: "/home/bo/work/staging.yaml" },
  ];
  const home = "/home/bo";

  it("prefers the same kubeconfig, written from anyone's home", () => {
    expect(matchContext({ context: "prod", kubeConfig: "~/.kube/jet-pilot/config" }, known, home)).toBe(known[1]);
    expect(matchContext({ context: "prod" }, known, home)).toBe(known[0]);
  });

  it("falls back to the only context of that name, or a file of the same name", () => {
    expect(matchContext({ context: "staging", kubeConfig: "~/Downloads/staging.yaml" }, known, home)).toBe(known[2]);
    expect(matchContext({ context: "staging" }, known, home)).toBe(known[2]);
    expect(matchContext({ context: "prod", kubeConfig: "/elsewhere/other.yaml" }, known, home)).toBe(known[0]);
  });

  it("never invents a cluster", () => {
    expect(matchContext({ context: "dev", kubeConfig: "/tmp/evil.yaml" }, known, home)).toBeNull();
  });
});
