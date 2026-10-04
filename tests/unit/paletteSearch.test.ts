import { describe, expect, it } from "vitest";
import { toDiscoveredResource } from "@/lib/discovery";
import {
  isJumpQuery,
  jumpRank,
  jumpTerm,
  matchResources,
  pushRecent,
} from "@/lib/paletteSearch";

const r = (name: string, kind: string, groupVersion: string, shortNames?: string[]) =>
  toDiscoveredResource({ name, kind, namespaced: true, shortNames }, groupVersion);

const resources = [
  r("pods", "Pod", "v1", ["po"]),
  r("deployments", "Deployment", "apps/v1", ["deploy"]),
  r("daemonsets", "DaemonSet", "apps/v1", ["ds"]),
  r("services", "Service", "v1", ["svc"]),
  r("deployments", "Deployment", "example.com/v1"),
  r("certificates", "Certificate", "cert-manager.io/v1", ["cert", "certs"]),
];

describe("palette resource jump", () => {
  it("recognises jump queries", () => {
    expect(isJumpQuery(":po")).toBe(true);
    expect(isJumpQuery("  :deploy")).toBe(true);
    expect(isJumpQuery("pods")).toBe(false);
    expect(jumpTerm(":Deploy ")).toBe("deploy");
  });

  it("matches short names, kinds and plurals exactly first", () => {
    expect(matchResources(resources, "po")[0].name).toBe("pods");
    expect(matchResources(resources, "svc")[0].name).toBe("services");
    expect(matchResources(resources, "cert")[0].name).toBe("certificates");
    expect(matchResources(resources, "deployment")[0].group).toBe("apps");
  });

  it("prefers built-in groups over CRDs with the same name", () => {
    const deploys = matchResources(resources, "deploy");
    expect(deploys.map((d) => d.group)).toEqual(["apps", "example.com"]);
  });

  it("falls back to prefixes, substrings and in-order characters", () => {
    expect(jumpRank(resources[1], "depl")).toBe(10);
    expect(jumpRank(resources[5], "manager")).toBe(20);
    expect(jumpRank(resources[2], "dmn")).toBe(30);
    expect(jumpRank(resources[0], "xyz")).toBeNull();
  });

  it("lists everything for an empty term", () => {
    expect(matchResources(resources, "")).toHaveLength(resources.length);
  });
});

describe("recent items", () => {
  it("moves items to the front, deduplicated and bounded", () => {
    let recent: string[] = [];
    for (const key of ["a", "b", "c", "a"]) recent = pushRecent(recent, key, 3);
    expect(recent).toEqual(["a", "c", "b"]);
    expect(pushRecent(recent, "d", 3)).toEqual(["d", "a", "c"]);
  });
});
