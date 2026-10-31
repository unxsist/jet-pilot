import { describe, expect, test } from "vitest";
import { addMinors, compareMinor, minorOf, minorsBetween, versionOf } from "@/lib/upgrades/versions";
import { nextMinorOn, platformOf, supportBadge, supportOf } from "@/lib/upgrades/support";
import { apiFindings, apiRule, apiState, kindsToScan, usesOfObject, type ApiUse } from "@/lib/upgrades/apis";
import { addonStatus, componentVersions, findAddons, splitImage } from "@/lib/upgrades/addons";
import { nodeVersions } from "@/lib/upgrades/check";
import { addonsSummary, apiFindingWords, apiGroups, apisSummary, nodesSummary } from "@/lib/upgrades/words";
import apis from "@/lib/upgrades/data/apis.json";
import platforms from "@/lib/upgrades/data/platforms.json";

const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe("versions", () => {
  test("minors of server, kubelet and image versions", () => {
    expect(minorOf("v1.31.4-eks-2d5f260")).toBe("1.31");
    expect(minorOf("v1.32.2-gke.1182003")).toBe("1.32");
    expect(minorOf("1.9")).toBe("1.9");
    expect(minorOf("latest")).toBeNull();
    expect(minorOf(null)).toBeNull();
    expect(versionOf("v1.15.1")).toBe("1.15.1");
    expect(versionOf("1.11.1-alpine")).toBe("1.11.1");
    expect(versionOf("main")).toBeNull();
  });

  test("minors compare numerically", () => {
    expect(compareMinor("1.9", "1.10")).toBeLessThan(0);
    expect(compareMinor("1.31", "1.31")).toBe(0);
    expect(addMinors("1.31", 2)).toBe("1.33");
    expect(addMinors("1.31", -3)).toBe("1.28");
    expect(minorsBetween("1.31", "1.33")).toBe(2);
    expect(minorsBetween("1.33", "1.31")).toBe(-2);
  });
});

describe("support", () => {
  test("the platform comes from the build, the nodes, then the kubeconfig", () => {
    expect(platformOf({ version: "v1.31.4-eks-2d5f260" })).toBe("eks");
    expect(platformOf({ version: "v1.32.2-gke.1182003", provider: "aws" })).toBe("gke");
    expect(platformOf({ version: "v1.31.2", nodeLabels: { "kubernetes.azure.com/cluster": "MC_x" } })).toBe("aks");
    expect(platformOf({ version: "v1.31.2", provider: "azure" })).toBe("aks");
    expect(platformOf({ version: "v1.31.2", provider: "digitalocean" })).toBe("kubernetes");
    expect(platformOf({})).toBe("kubernetes");
  });

  test("EKS: standard, ending, extended (extra fee), extended ending, ended", () => {
    // 1.31: standard until 2025-11-26, extended until 2026-11-26.
    expect(supportOf("eks", "v1.31.4-eks-1", at("2025-05-01"))).toMatchObject({ phase: "supported", tone: "success", headline: "Supported until Nov 26, 2025" });
    expect(supportOf("eks", "v1.31.4-eks-1", at("2025-10-01"))).toMatchObject({ phase: "ending", tone: "warning", headline: "Standard support ends in 56 days" });
    const extended = supportOf("eks", "v1.31.4-eks-1", at("2026-03-01"))!;
    expect(extended).toMatchObject({ phase: "extended", tone: "warning", headline: "Extended support until Nov 26, 2026" });
    expect(extended.detail).toBe("Standard support ended Nov 26, 2025. Extended support costs extra.");
    const late = supportOf("eks", "v1.31.4-eks-1", at("2026-10-31"))!;
    expect(late).toMatchObject({ phase: "extended", tone: "destructive", headline: "Extended support ends in 26 days" });
    expect(late.detail).toContain("EKS upgrades the control plane itself");
    expect(supportOf("eks", "v1.31.4-eks-1", at("2027-01-01"))).toMatchObject({ phase: "ended", headline: "Out of support since Nov 26, 2026" });
  });

  test("upstream, unknown and newer versions", () => {
    expect(supportOf("kubernetes", "v1.30.4", at("2026-10-31"))).toMatchObject({ phase: "ended", tone: "destructive", headline: "Out of support since Jul 15, 2025" });
    expect(supportOf("kubernetes", "v1.2.0", at("2026-10-31"))).toMatchObject({ phase: "ended", headline: "Out of support" });
    expect(supportOf("kubernetes", "v9.99.0", at("2026-10-31"))).toMatchObject({ phase: "newer", tone: "muted" });
    expect(supportOf("kubernetes", "garbage")).toBeNull();
    const latest = platforms.platforms.kubernetes.releases[0]!.cycle;
    expect(supportOf("kubernetes", "v1.30.4", at("2026-10-31"))!.latest).toBe(latest);
  });

  test("AKS long-term support needs the Premium tier", () => {
    // 1.31: standard until 2025-11-01, LTS until 2026-11-30.
    const aks = supportOf("aks", "v1.31.2", at("2026-03-01"))!;
    expect(aks.headline).toBe("Long-term support until Nov 30, 2026");
    expect(aks.detail).toContain("Premium tier");
  });

  test("the hub badge only shows near or past the end of support", () => {
    expect(supportBadge(supportOf("eks", "v1.31.4-eks-1", at("2025-05-01")))).toBeNull();
    expect(supportBadge(supportOf("eks", "v1.31.4-eks-1", at("2025-10-01")))).toMatchObject({ text: "Support ends soon" });
    expect(supportBadge(supportOf("eks", "v1.31.4-eks-1", at("2026-03-01")))).toMatchObject({ text: "Extended support" });
    expect(supportBadge(supportOf("aks", "v1.31.2", at("2026-03-01")))).toMatchObject({ text: "Out of standard support" });
    const ended = supportBadge(supportOf("kubernetes", "v1.30.4", at("2026-10-31")))!;
    expect(ended.text).toBe("Out of support");
    expect(ended.title).toBe("Kubernetes 1.30: Out of support since Jul 15, 2025.");
    expect(supportBadge(null)).toBeNull();
  });

  test("the next minor on a platform", () => {
    expect(nextMinorOn("eks", "1.31")).toBe("1.32");
    const latest = platforms.platforms.eks.releases[0]!.cycle;
    expect(nextMinorOn("eks", latest)).toBeNull();
  });
});

describe("deprecated APIs", () => {
  test("the bundled table keeps Pluto's licence notice", () => {
    expect(apis.notice).toContain("Apache License, Version 2.0");
    expect(apis.notice).toContain("FairwindsOps");
    expect(apis.apis.some((a) => a.kind.endsWith("List"))).toBe(false);
  });

  test("states relative to the cluster's version", () => {
    const flowSchema = apiRule("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema")!;
    expect(apiState(flowSchema, "1.30")).toBe("removing");
    expect(apiState(flowSchema, "1.31")).toBe("removing");
    expect(apiState(flowSchema, "1.32")).toBe("removed");
    expect(apiState(flowSchema, "1.26")).toBe("deprecated");
    expect(apiState(flowSchema, "1.23")).toBeNull();
    expect(apiState(flowSchema, null)).toBeNull();
  });

  test("uses from last-applied and managedFields", () => {
    const uses = usesOfObject("Ingress", {
      metadata: {
        name: "legacy-site",
        namespace: "default",
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration": '{"apiVersion":"networking.k8s.io/v1beta1","kind":"Ingress"}',
        },
        managedFields: [
          { manager: "kubectl-client-side-apply", apiVersion: "networking.k8s.io/v1beta1", time: "2021-01-01T00:00:00Z" },
          { manager: "kubectl-client-side-apply", apiVersion: "networking.k8s.io/v1beta1", subresource: "status" },
          { manager: "nginx-ingress-controller", apiVersion: "networking.k8s.io/v1" },
        ],
      },
    });
    expect(uses.map((u) => [u.apiVersion, u.source.type])).toEqual([
      ["networking.k8s.io/v1beta1", "applied"],
      ["networking.k8s.io/v1beta1", "manager"],
      ["networking.k8s.io/v1", "manager"],
    ]);
  });

  test("findings: Helm first, stale managers left out, old manifests last", () => {
    const uses: ApiUse[] = [
      { apiVersion: "networking.k8s.io/v1beta1", kind: "Ingress", name: "legacy-site", namespace: "default", source: { type: "applied" } },
      { apiVersion: "networking.k8s.io/v1beta1", kind: "Ingress", name: "legacy-site", namespace: "default", source: { type: "manager", manager: "kubectl", at: null } },
      { apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", kind: "FlowSchema", name: "karpenter-leader-election", source: { type: "helm", release: "karpenter", namespace: "kube-system" } },
      { apiVersion: "policy/v1beta1", kind: "PodDisruptionBudget", name: "web", source: { type: "helm", release: "shop", namespace: "shop" } },
      { apiVersion: "apps/v1", kind: "Deployment", name: "fine", source: { type: "applied" } },
      { apiVersion: "cert-manager.io/v1alpha2", kind: "Certificate", name: "old", source: { type: "helm", release: "certs", namespace: "a" } },
    ];
    const findings = apiFindings(uses, "1.31");
    expect(findings.map((f) => [f.name, f.state, f.source.type])).toEqual([
      ["web", "removed", "helm"],
      ["karpenter-leader-election", "removing", "helm"],
      ["legacy-site", "removed", "applied"],
    ]);
    // Add-on APIs compare against the add-on's version.
    expect(apiFindings(uses, "1.31", { "cert-manager": "1.15" }).some((f) => f.name === "old" && f.state === "removed")).toBe(true);
  });

  test("kinds to scan skip controller-made objects", () => {
    const kinds = kindsToScan("1.31").map((k) => k.kind);
    expect(kinds).toContain("FlowSchema");
    expect(kinds).toContain("Ingress");
    expect(kinds).not.toContain("Event");
    expect(kinds).not.toContain("ReplicaSet");
    const ingress = kindsToScan("1.31").find((k) => k.kind === "Ingress")!;
    expect(ingress.groups.sort()).toEqual(["extensions", "networking.k8s.io"]);
  });
});

describe("add-ons", () => {
  test("images split into repository and tag", () => {
    expect(splitImage("quay.io/cilium/cilium:v1.15.5@sha256:abc")).toEqual({ repository: "quay.io/cilium/cilium", tag: "v1.15.5" });
    expect(splitImage("localhost:5000/app")).toEqual({ repository: "localhost:5000/app", tag: null });
    expect(splitImage("calico/node:v3.27.0")).toEqual({ repository: "calico/node", tag: "v3.27.0" });
  });

  test("found from Helm charts, labels and images", () => {
    const found = findAddons(
      [{ name: "cm", namespace: "cert-manager", chart: "cert-manager", chartVersion: "v1.15.1", appVersion: "v1.15.1" }],
      [
        { kind: "Deployment", name: "source-controller", namespace: "flux-system", labels: { "app.kubernetes.io/part-of": "flux", "app.kubernetes.io/version": "v2.3.0" }, images: ["ghcr.io/fluxcd/source-controller:v1.3.0"] },
        { kind: "DaemonSet", name: "calico-node", namespace: "calico-system", labels: {}, images: ["docker.io/calico/node:v3.27.0"] },
        { kind: "Deployment", name: "ingress-nginx-controller", namespace: "ingress-nginx", labels: {}, images: ["registry.k8s.io/ingress-nginx/controller:v1.11.1@sha256:x"] },
        { kind: "Deployment", name: "metrics-server", namespace: "kube-system", labels: {}, images: ["registry.k8s.io/metrics-server/metrics-server:v0.7.1"] },
      ]
    );
    expect(found.map((a) => [a.id, a.version])).toEqual([
      ["cert-manager", "1.15.1"],
      ["ingress-nginx", "1.11.1"],
      ["flux", "2.3.0"],
      ["calico", "3.27.0"],
      ["metrics-server", "0.7.1"],
    ]);
    expect(found[0]!.where).toBe("Helm release cm in cert-manager");
    expect(componentVersions(found)).toEqual({ "cert-manager": "1.15" });
  });

  test("support status in words", () => {
    const now = at("2026-10-31");
    const base = { where: "x" };
    expect(addonStatus({ ...base, id: "cert-manager", label: "cert-manager", version: "1.15.1" }, now)).toMatchObject({
      phase: "ended",
      headline: "Out of support since Feb 3, 2025",
    });
    expect(addonStatus({ ...base, id: "ingress-nginx", label: "ingress-nginx", version: "1.11.1" }, now)).toMatchObject({ phase: "retired" });
    expect(addonStatus({ ...base, id: "karpenter", label: "Karpenter", version: "0.37.0" }, now)).toMatchObject({ phase: "ended", headline: "Out of support" });
    expect(addonStatus({ ...base, id: "metrics-server", label: "metrics-server", version: "0.7.1" }, now)).toMatchObject({ phase: "unknown", headline: null });
    expect(addonStatus({ ...base, id: "argo-cd", label: "Argo CD", version: null }, now)).toMatchObject({ phase: "unknown" });
  });
});

describe("node versions", () => {
  const node = (v: string) => ({ status: { nodeInfo: { kubeletVersion: v } } });
  test("counts nodes the next control plane would leave behind", () => {
    const nodes = [node("v1.31.2"), node("v1.31.2"), node("v1.28.9"), node("v1.29.1")];
    expect(nodeVersions(nodes, "1.31", "1.32")).toEqual({
      total: 4,
      minors: [
        { minor: "1.31", count: 2 },
        { minor: "1.29", count: 1 },
        { minor: "1.28", count: 1 },
      ],
      tooOld: 1,
    });
    expect(nodeVersions(nodes, "1.31", null).tooOld).toBe(0);
  });
});

describe("words", () => {
  const helm = (name: string, release = "karpenter"): ApiUse => ({
    apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3",
    kind: "FlowSchema",
    name,
    source: { type: "helm", release, namespace: "kube-system" },
  });

  test("findings read as one line per kind, version and source", () => {
    const findings = apiFindings(
      [
        helm("karpenter-leader-election"),
        helm("karpenter-workload"),
        { apiVersion: "networking.k8s.io/v1beta1", kind: "Ingress", name: "legacy-site", namespace: "default", source: { type: "applied" } },
        { apiVersion: "policy/v1beta1", kind: "PodDisruptionBudget", name: "web", source: { type: "helm", release: "shop", namespace: "shop" } },
      ],
      "1.31"
    );
    expect(apiGroups(findings).map((g) => [g.title, g.when, g.tone])).toEqual([
      ["PodDisruptionBudget web", "Removed in 1.25", "warning"],
      ["2 FlowSchemas: karpenter-leader-election and karpenter-workload", "Removed in 1.32", "warning"],
      ["Ingress legacy-site", "Removed in 1.22", "muted"],
    ]);
    expect(apiFindingWords(findings[0]!).detail).toBe(
      "Helm release shop still has policy/v1beta1, so helm upgrade fails until its stored manifest is fixed (helm mapkubeapis)."
    );
    expect(apiFindingWords(findings[1]!).detail).toBe(
      "Helm release karpenter renders flowcontrol.apiserver.k8s.io/v1beta3. Use flowcontrol.apiserver.k8s.io/v1."
    );
    expect(apisSummary(findings)).toEqual({ text: "4 objects use deprecated or removed APIs", tone: "warning" });
    expect(apisSummary([])).toEqual({ text: "None in use", tone: "success" });
  });

  test("add-ons and nodes in a sentence", () => {
    const now = at("2026-10-31");
    const status = (id: string, label: string, version: string) => addonStatus({ id, label, version, where: "x" }, now);
    expect(addonsSummary([status("cert-manager", "cert-manager", "1.15.1"), status("ingress-nginx", "ingress-nginx", "1.11.1"), status("metrics-server", "metrics-server", "0.7.1")]).text).toBe(
      "cert-manager and ingress-nginx need an update"
    );
    expect(addonsSummary([status("metrics-server", "metrics-server", "0.7.1")])).toEqual({ text: "1 add-on, all supported", tone: "success" });
    expect(addonsSummary([]).tone).toBe("muted");
    expect(nodesSummary({ total: 4, minors: [{ minor: "1.30", count: 4 }], tooOld: 0 }, "1.32").text).toBe("4 nodes on 1.30");
    expect(nodesSummary({ total: 3, minors: [{ minor: "1.31", count: 2 }, { minor: "1.29", count: 1 }], tooOld: 0 }, "1.32").text).toBe("2 nodes on 1.31, 1 on 1.29");
    expect(nodesSummary({ total: 3, minors: [{ minor: "1.31", count: 2 }, { minor: "1.27", count: 1 }], tooOld: 1 }, "1.32")).toEqual({
      text: "1 node is too old for 1.32: upgrade it first",
      tone: "warning",
    });
  });
});
