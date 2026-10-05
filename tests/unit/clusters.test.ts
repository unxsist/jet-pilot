import { describe, expect, it } from "vitest";
import {
  findRecord,
  inferEnvironment,
  initialsOf,
  resolveCluster,
  shortName,
  updateRecords,
  type ClusterRecord,
} from "@/lib/clusters/meta";
import { detectProvider } from "@/lib/clusters/provider";
import { buildSections, folderNames, parseHubFilter, type HubCluster } from "@/lib/clusters/hubModel";
import { mergeContextSettings } from "@/lib/settings/store";
import type { InventoryEntry } from "@/lib/clusters/inventory";

const KC = "/home/me/.kube/config";

describe("cluster metadata", () => {
  const records: ClusterRecord[] = [
    { kubeConfig: "", context: "prod", namespaces: ["payments"] },
    { kubeConfig: KC, context: "prod", alias: "Payments prod", env: "prod" },
    { kubeConfig: "/other", context: "staging", color: "amber" },
  ];

  it("prefers an exact record, then a wildcard", () => {
    expect(findRecord(records, "prod", KC)?.alias).toBe("Payments prod");
    expect(findRecord(records, "prod", "/elsewhere")?.namespaces).toEqual(["payments"]);
    expect(findRecord(records, "staging", KC)).toBeUndefined();
    expect(findRecord(records, "staging")?.color).toBe("amber");
  });

  it("resolves display name, initials, colour and guardrails", () => {
    const prod = resolveCluster(records, "prod", KC);
    expect(prod).toMatchObject({ displayName: "Payments prod", initials: "PP", env: "prod", envInferred: false, protected: true });
    const staging = resolveCluster(records, "staging", "/other");
    expect(staging.hue).toBe(40);
    expect(staging.protected).toBe(false);
  });

  it("infers the environment as a hint only", () => {
    const resolved = resolveCluster([], "prod-eu-west-1", KC);
    expect(resolved.env).toBe("prod");
    expect(resolved.envInferred).toBe(true);
    expect(resolved.protected).toBe(false);
    expect(inferEnvironment("gke_acme_europe-west4_staging-1")).toBe("staging");
    expect(inferEnvironment("productivity-tools")).toBeUndefined();
  });

  it("names EKS ARNs and GKE paths by their cluster", () => {
    expect(shortName("arn:aws:eks:eu-west-1:123456789012:cluster/payments")).toBe("payments");
    expect(shortName("gke_acme-prod_europe-west4_checkout")).toBe("checkout");
    expect(initialsOf("gke_acme-prod_europe-west4_checkout")).toBe("CH");
  });

  it("updates records and drops empty ones", () => {
    let next = updateRecords(records, "prod", "/elsewhere", { favorite: true });
    expect(findRecord(next, "prod", "/elsewhere")).toMatchObject({ kubeConfig: "/elsewhere", favorite: true, namespaces: ["payments"] });
    next = updateRecords(next, "staging", "/other", { color: undefined });
    expect(findRecord(next, "staging", "/other")).toBeUndefined();
  });

  it("protection can be turned off for production", () => {
    const next = updateRecords([], "prod", KC, { env: "prod", protected: false });
    expect(resolveCluster(next, "prod", KC).protected).toBe(false);
  });
});

describe("contextSettings migration", () => {
  it("turns namespace lists into wildcard records", () => {
    expect(
      mergeContextSettings([{ kubeConfig: "", context: "a", alias: "A" }], [
        { context: "a", namespaces: ["x"] },
        { context: "b", namespaces: ["y", ""] },
        { context: "c", namespaces: [] },
      ])
    ).toEqual([
      { kubeConfig: "", context: "a", alias: "A", namespaces: ["x"] },
      { kubeConfig: "", context: "b", namespaces: ["y"] },
    ]);
  });
});

describe("detectProvider", () => {
  it.each([
    [{ context: "arn:aws:eks:eu-west-1:123456789012:cluster/prod" }, "aws", "123456789012", "eu-west-1"],
    [{ context: "x", server: "https://ABC.gr7.us-east-2.eks.amazonaws.com" }, "aws", undefined, "us-east-2"],
    [{ context: "gke_acme-prod_europe-west4_checkout" }, "gcp", "acme-prod", "europe-west4"],
    [{ context: "x", server: "https://a-dns-1.hcp.westeurope.azmk8s.io:443" }, "azure", undefined, "westeurope"],
    [{ context: "do-ams3-hobby", server: "https://5d1e.k8s.ondigitalocean.com" }, "digitalocean", undefined, "ams3"],
    [{ context: "lke1", server: "https://8f3a.eu-central.linodelke.net:443" }, "linode", undefined, "eu-central"],
    [{ context: "x", server: "https://5b2f.api.k8s.nl-ams.scw.cloud:6443" }, "scaleway", undefined, "nl-ams"],
    [{ context: "x", server: "https://abc.vultr-k8s.com:6443" }, "vultr", undefined, undefined],
    [{ context: "x", server: "https://abc.sks-ch-gva-2.exo.io:443" }, "exoscale", undefined, "ch-gva-2"],
    [{ context: "kind-dev", server: "https://127.0.0.1:52341" }, "local", undefined, undefined],
    [{ context: "x", authCommand: "gke-gcloud-auth-plugin" }, "gcp", undefined, undefined],
    [{ context: "staging", authCommand: "kubelogin", server: "https://k8s.example.com" }, "other", undefined, undefined],
  ])("%o → %s", (input, id, account, region) => {
    const provider = detectProvider(input);
    expect(provider.id).toBe(id);
    expect(provider.account).toBe(account);
    expect(provider.region).toBe(region);
  });
});

const hubCluster = (context: string, meta: Partial<HubCluster["meta"]> = {}, extra: Partial<HubCluster> = {}): HubCluster => {
  const resolved = resolveCluster([], context, KC);
  return {
    entry: {
      key: `${KC}|${context}`,
      context,
      kubeConfig: KC,
      cluster: context,
      user: "u",
      auth: { kind: "token" },
      problems: [],
      provider: detectProvider({ context }),
      origin: "default",
      current: false,
    } as InventoryEntry,
    meta: { ...resolved, envInferred: false, ...meta },
    active: false,
    ...extra,
  };
};

describe("hub model", () => {
  const list = [
    hubCluster("checkout", { favorite: true, folder: "Storefront", env: "prod", protected: true }),
    hubCluster("sandbox", { folder: "Storefront", env: "dev", tags: ["shared"] }),
    hubCluster("analytics", { folder: "Data" }),
    hubCluster("old", { hidden: true }),
    hubCluster("arn:aws:eks:eu-west-1:123456789012:cluster/payments", {}, { active: true }),
  ];

  it("parses filter tokens", () => {
    const filter = parseHubFilter("pay env:prod is:favorite tag:Shared");
    expect(filter.text).toBe("pay");
    expect(filter.env).toBe("prod");
    expect(filter.tag).toBe("shared");
    expect([...filter.is]).toEqual(["favorite"]);
  });

  it("puts favourites first, groups the rest and keeps hidden ones out", () => {
    const sections = buildSections(list, "folder", parseHubFilter(""), false);
    expect(sections.favorites.map((c) => c.entry.context)).toEqual(["checkout"]);
    expect(sections.groups.map((g) => [g.title, g.clusters.map((c) => c.meta.displayName)])).toEqual([
      ["Data", ["analytics"]],
      ["Storefront", ["sandbox"]],
      ["No folder", ["payments"]],
    ]);
    expect(sections.hidden).toEqual([]);
    expect(buildSections(list, "folder", parseHubFilter(""), true).hidden).toHaveLength(1);
    expect(buildSections(list, "none", parseHubFilter("is:hidden"), false).hidden).toHaveLength(1);
  });

  it("filters by text and tokens", () => {
    const names = (query: string) => {
      const s = buildSections(list, "none", parseHubFilter(query), false);
      return [...s.favorites, ...s.groups.flatMap((g) => g.clusters)].map((c) => c.meta.displayName);
    };
    expect(names("env:prod")).toEqual(["checkout"]);
    expect(names("tag:shared")).toEqual(["sandbox"]);
    expect(names("is:active")).toEqual(["payments"]);
    expect(names("provider:aws")).toEqual(["payments"]);
    expect(names("eu-west")).toEqual(["payments"]);
    expect(names("is:protected")).toEqual(["checkout"]);
  });

  it("groups by provider with the account", () => {
    const sections = buildSections(list, "provider", parseHubFilter(""), false);
    expect(sections.groups[0]).toMatchObject({ title: "Amazon EKS", detail: "123456789012" });
  });

  it("lists folder names", () => {
    expect(folderNames(list)).toEqual(["Data", "Storefront"]);
  });
});
