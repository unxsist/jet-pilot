import { describe, expect, it } from "vitest";
import {
  availableInHub,
  connectionScope,
  defaultRole,
  discoverySummary,
  expiryText,
  failureGroups,
  failureSummary,
  groupCatalog,
  initialDiscovery,
  knownPortals,
  parseStartUrl,
  portalName,
  reduceDiscovery,
  regionsSummary,
} from "@/lib/clusters/cloudModel";
import { parseHubFilter, matchesFilter, type HubCluster } from "@/lib/clusters/hubModel";
import { initialsOf, shortName } from "@/lib/clusters/meta";
import type { AwsProfile, CatalogCluster, CloudConnection } from "@/lib/clusters/cloud";

const cluster = (name: string, patch: Partial<CatalogCluster> = {}): CatalogCluster => ({
  key: `aws:c1:111111111111:eu-west-1:${name}`,
  provider: "aws",
  connectionId: "c1",
  accountId: "111111111111",
  accountName: "acme-production",
  roleName: "EKSClusterAdmin",
  region: "eu-west-1",
  name,
  version: "1.31",
  status: "ACTIVE",
  endpoint: null,
  createdAt: null,
  state: "available",
  addedContext: null,
  ...patch,
});

const connection = (patch: Partial<CloudConnection>): CloudConnection => ({
  id: "c1",
  provider: "aws",
  kind: "sso",
  label: "acme",
  regions: [],
  targets: [],
  status: "signedIn",
  createdAt: 0,
  ...patch,
});

describe("start URLs", () => {
  it("accepts what people paste", () => {
    expect(parseStartUrl("https://acme.awsapps.com/start")).toBe("https://acme.awsapps.com/start");
    expect(parseStartUrl("https://acme.awsapps.com/start/#/")).toBe("https://acme.awsapps.com/start");
    expect(parseStartUrl("acme.awsapps.com/start")).toBe("https://acme.awsapps.com/start");
    expect(parseStartUrl("ACME")).toBe("https://acme.awsapps.com/start");
    expect(parseStartUrl("d-1234567890")).toBe("https://d-1234567890.awsapps.com/start");
    expect(parseStartUrl("https://acme.awsapps.com")).toBe("https://acme.awsapps.com/start");
    expect(parseStartUrl("https://start.us-gov-home.awsapps.com/directory/acme")).toBe(
      "https://start.us-gov-home.awsapps.com/directory/acme"
    );
  });

  it("refuses what can't be a portal", () => {
    expect(parseStartUrl("")).toBeNull();
    expect(parseStartUrl("http://acme.awsapps.com/start")).toBeNull();
    expect(parseStartUrl("not a url")).toBeNull();
  });

  it("names portals", () => {
    expect(portalName("https://acme.awsapps.com/start")).toBe("acme");
    expect(portalName("https://sso.example.com/start")).toBe("sso.example.com");
  });

  it("finds the portals ~/.aws/config uses, most used first", () => {
    const profile = (name: string, url: string | null, region: string | null = null): AwsProfile => ({
      name,
      kind: url ? "sso" : "static",
      ssoStartUrl: url,
      ssoRegion: region,
      mfa: false,
    });
    expect(
      knownPortals([
        profile("a", "https://b.awsapps.com/start"),
        profile("b", "https://a.awsapps.com/start/", "eu-west-1"),
        profile("c", "https://a.awsapps.com/start"),
        profile("d", null),
      ])
    ).toEqual([
      { startUrl: "https://a.awsapps.com/start", region: "eu-west-1", profiles: 2 },
      { startUrl: "https://b.awsapps.com/start", region: null, profiles: 1 },
    ]);
  });
});

describe("roles", () => {
  it("prefers the role picked elsewhere, then a Kubernetes one, then the first", () => {
    expect(defaultRole(["ReadOnlyAccess", "AdministratorAccess"], ["ReadOnlyAccess"])).toBe("ReadOnlyAccess");
    expect(defaultRole(["ReadOnlyAccess", "EKSClusterAdmin", "AdministratorAccess"])).toBe("EKSClusterAdmin");
    expect(defaultRole(["ReadOnlyAccess", "AdministratorAccess"])).toBe("AdministratorAccess");
    expect(defaultRole([])).toBeNull();
  });
});

describe("summaries", () => {
  it("describes regions", () => {
    expect(regionsSummary([])).toBe("All enabled regions");
    expect(regionsSummary(["eu-west-1", "us-east-1"])).toBe("eu-west-1, us-east-1");
    expect(regionsSummary(["eu-west-1", "us-east-1", "us-west-2", "ap-south-1"])).toBe("eu-west-1, us-east-1 and 2 more");
  });

  it("describes what a connection reaches", () => {
    const target = { accountId: "111111111111", accountName: "acme-production", roleName: "Admin" };
    expect(connectionScope(connection({ targets: [target] }))).toBe("acme-production");
    expect(connectionScope(connection({ targets: [target, { ...target, accountId: "2" }] }))).toBe("2 accounts");
    expect(connectionScope(connection({ kind: "profile", profile: "prod" }))).toBe("Profile prod");
    expect(connectionScope(connection({ kind: "keys", identity: "arn:aws:iam::789012345678:user/ci" }))).toBe(
      "Account 789012345678"
    );
    expect(connectionScope(connection({ kind: "keys", identity: null }))).toBe("Access keys");
  });

  it("describes expiry", () => {
    const now = 1_000_000_000;
    expect(expiryText(null, now)).toBeNull();
    expect(expiryText(now + 7 * 3600_000, now)).toBe("7 h left");
    expect(expiryText(now + 12 * 60_000, now)).toBe("12 min left");
    expect(expiryText(now - 3 * 3600_000, now)).toBe("expired 3 h ago");
  });
});

describe("catalog", () => {
  it("groups by state, sorted by account, region and name", () => {
    const groups = groupCatalog([
      cluster("b"),
      cluster("a", { region: "us-east-1" }),
      cluster("c", { accountName: "acme-dev" }),
      cluster("d", { state: "added" }),
      cluster("e", { state: "ignored" }),
      cluster("f", { state: "removed" }),
    ]);
    expect(groups.available.map((c) => c.name)).toEqual(["c", "b", "a"]);
    expect(groups.added.map((c) => c.name)).toEqual(["d"]);
    expect(groups.ignored.map((c) => c.name)).toEqual(["e"]);
    expect(groups.removed.map((c) => c.name)).toEqual(["f"]);
  });

  it("filters the hub's Available section", () => {
    const list = [cluster("payments"), cluster("analytics", { region: "us-west-2" }), cluster("airflow", { state: "ignored" })];
    const names = (query: string, showHidden = false) => {
      const result = availableInHub(list, parseHubFilter(query), showHidden);
      return [...result.available, ...result.ignored].map((c) => c.name);
    };
    expect(names("")).toEqual(["payments", "analytics"]);
    expect(names("", true)).toEqual(["payments", "analytics", "airflow"]);
    expect(names("us-west")).toEqual(["analytics"]);
    expect(names("provider:aws pay")).toEqual(["payments"]);
    expect(names("provider:gcp")).toEqual([]);
    expect(names("env:prod")).toEqual([]);
    expect(names("is:favorite")).toEqual([]);
    expect(names("is:available")).toEqual(["payments", "analytics"]);
    expect(names("is:hidden")).toEqual(["airflow"]);
  });

  it("keeps added clusters out of is:available", () => {
    const hub = { entry: { provider: { id: "aws", label: "Amazon EKS" } }, meta: { tags: [] } } as unknown as HubCluster;
    expect(matchesFilter(hub, parseHubFilter("is:available"))).toBe(false);
  });
});

describe("discovery", () => {
  it("reduces refresh events", () => {
    let state = initialDiscovery();
    state = reduceDiscovery(state, { type: "progress", connectionId: "c1", scope: "regions", state: "running" });
    state = reduceDiscovery(state, { type: "progress", connectionId: "c1", scope: "regions", state: "done" });
    state = reduceDiscovery(state, {
      type: "progress",
      connectionId: "c1",
      scope: "acme · eu-west-1",
      accountId: "1",
      accountName: "acme",
      region: "eu-west-1",
      state: "error",
      message: "AccessDenied",
    });
    state = reduceDiscovery(state, { type: "clusters", connectionId: "c1", clusters: [cluster("a"), cluster("b")] });
    state = reduceDiscovery(state, { type: "clusters", connectionId: "c1", clusters: [cluster("a", { version: "1.32" })] });
    expect(state.scopes).toHaveLength(2);
    expect(state.clusters.map((c) => [c.name, c.version])).toEqual([
      ["b", "1.31"],
      ["a", "1.32"],
    ]);
    expect(discoverySummary(state)).toMatchObject({ total: 2, finished: 2, found: 2 });
    expect(state.done).toBe(false);
    state = reduceDiscovery(state, { type: "done", refreshedAt: 42 });
    expect(state).toMatchObject({ done: true, refreshedAt: 42 });
  });

  it("summarises failures per account", () => {
    const scope = (account: string, region: string) => ({
      scope: `${account} · ${region}`,
      accountName: account,
      region,
      message: "AccessDenied",
    });
    const one = failureGroups([scope("audit", "eu-west-1"), scope("audit", "us-east-1")]);
    expect(one).toEqual([{ account: "audit", regions: ["eu-west-1", "us-east-1"], message: "AccessDenied" }]);
    expect(failureSummary(one)).toBe("audit couldn't be checked in 2 regions");
    expect(failureSummary(failureGroups([scope("audit", "eu-west-1")]))).toBe("audit couldn't be checked");
    expect(failureSummary(failureGroups([scope("a", "x"), scope("b", "y")]))).toBe("2 accounts couldn't be fully checked");
    expect(failureSummary([])).toBeNull();
  });
});

describe("names of clusters added from AWS", () => {
  it("shows the cluster name", () => {
    expect(shortName("eks-eu-west-1-prod-eu")).toBe("prod-eu");
    expect(shortName("eks-us-gov-west-1-ledger")).toBe("ledger");
    expect(shortName("eks-dev")).toBe("eks-dev");
    expect(initialsOf("eks-eu-central-1-payments")).toBe("PA");
  });
});
