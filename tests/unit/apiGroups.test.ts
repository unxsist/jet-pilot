import { describe, expect, test } from "vitest";
import {
  groupSections,
  isBuiltInGroup,
  listResourceName,
  MORE_RESOURCES,
  projectOf,
  sortProjectKinds,
} from "@/lib/apiGroups";
import type { DiscoveredResource } from "@/lib/discovery";

const r = (group: string, name: string, kind: string): DiscoveredResource => ({
  name,
  kind,
  group,
  version: "v1",
  namespaced: true,
  verbs: ["list", "watch"],
});

const options = {
  visible: (resources: DiscoveredResource[]) => resources.filter((x) => !x.name.includes("/")),
  sort: (a: DiscoveredResource, b: DiscoveredResource) => a.kind.localeCompare(b.kind),
};

describe("API group projects", () => {
  test("well-known groups get a human title", () => {
    expect(projectOf("cert-manager.io")?.title).toBe("cert-manager");
    expect(projectOf("acme.cert-manager.io")?.title).toBe("cert-manager");
    expect(projectOf("gateway.networking.k8s.io")?.title).toBe("Gateway API");
    expect(projectOf("karpenter.k8s.aws")?.title).toBe("Karpenter");
    expect(projectOf("eventing.keda.sh")?.title).toBe("KEDA");
    expect(projectOf("monitoring.coreos.com")?.title).toBe("Prometheus Operator");
    expect(projectOf("security.istio.io")?.title).toBe("Istio");
    expect(projectOf("notification.toolkit.fluxcd.io")?.title).toBe("Flux");
    expect(projectOf("postgresql.cnpg.io")?.title).toBe("CloudNativePG");
  });

  test("suffix patterns only match below the domain", () => {
    expect(projectOf("istio.io")).toBeUndefined();
    expect(projectOf("notistio.io")).toBeUndefined();
    expect(projectOf("widgets.acme.dev")).toBeUndefined();
    expect(projectOf("networking.k8s.io")).toBeUndefined();
  });

  test("built-in groups", () => {
    expect(isBuiltInGroup("")).toBe(true);
    expect(isBuiltInGroup("apps")).toBe(true);
    expect(isBuiltInGroup("networking.k8s.io")).toBe(true);
    expect(isBuiltInGroup("gateway.networking.k8s.io")).toBe(false);
    expect(isBuiltInGroup("cert-manager.io")).toBe(false);
  });

  test("project kinds come first, in the project's order", () => {
    const sorted = sortProjectKinds(projectOf("cert-manager.io")!, [
      r("acme.cert-manager.io", "challenges", "Challenge"),
      r("cert-manager.io", "issuers", "Issuer"),
      r("cert-manager.io", "widgets", "Widget"),
      r("cert-manager.io", "certificates", "Certificate"),
      r("cert-manager.io", "bananas", "Banana"),
    ]);
    expect(sorted.map((x) => x.kind)).toEqual(["Certificate", "Issuer", "Challenge", "Banana", "Widget"]);
  });
});

describe("navigation sections", () => {
  test("sibling groups merge into one section, sorted by title", () => {
    const sections = groupSections(
      [
        ["kustomize.toolkit.fluxcd.io", [r("kustomize.toolkit.fluxcd.io", "kustomizations", "Kustomization")]],
        ["source.toolkit.fluxcd.io", [r("source.toolkit.fluxcd.io", "gitrepositories", "GitRepository")]],
        ["karpenter.sh", [r("karpenter.sh", "nodepools", "NodePool"), r("karpenter.sh", "nodeclaims", "NodeClaim")]],
        ["karpenter.k8s.aws", [r("karpenter.k8s.aws", "ec2nodeclasses", "EC2NodeClass")]],
        ["cert-manager.io", [r("cert-manager.io", "certificates", "Certificate")]],
      ],
      options
    );
    expect(sections.map((s) => s.title)).toEqual(["cert-manager", "Flux", "Karpenter"]);
    expect(sections[1].items.map((x) => x.kind)).toEqual(["Kustomization", "GitRepository"]);
    expect(sections[2].items.map((x) => x.kind)).toEqual(["NodePool", "NodeClaim", "EC2NodeClass"]);
    expect(sections.every((s) => !s.tail)).toBe(true);
  });

  test("argoproj.io is Argo CD unless it serves other Argo kinds", () => {
    const cd = groupSections([["argoproj.io", [r("argoproj.io", "applications", "Application")]]], options);
    expect(cd[0].title).toBe("Argo CD");
    const mixed = groupSections(
      [["argoproj.io", [r("argoproj.io", "applications", "Application"), r("argoproj.io", "rollouts", "Rollout")]]],
      options
    );
    expect(mixed[0].title).toBe("Argo");
  });

  test("a few unknown groups keep their raw names after the projects", () => {
    const sections = groupSections(
      [
        ["widgets.acme.dev", [r("widgets.acme.dev", "widgets", "Widget")]],
        ["keda.sh", [r("keda.sh", "scaledobjects", "ScaledObject")]],
        ["metrics.k8s.io", [r("metrics.k8s.io", "pods", "PodMetrics")]],
      ],
      options
    );
    expect(sections.map((s) => s.title)).toEqual(["KEDA", "metrics.k8s.io", "widgets.acme.dev"]);
  });

  test("a long tail folds into More resources", () => {
    const tail = ["a.example.com", "b.example.com", "c.example.com", "d.example.com"].map(
      (group, i): [string, DiscoveredResource[]] => [group, [r(group, `things${i}`, `Thing${3 - i}`)]]
    );
    const sections = groupSections(tail, options);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe(MORE_RESOURCES);
    expect(sections[0].tail).toBe(true);
    expect(sections[0].items.map((x) => x.kind)).toEqual(["Thing0", "Thing1", "Thing2", "Thing3"]);
  });

  test("empty sections are left out", () => {
    const sections = groupSections(
      [["cert-manager.io", [r("cert-manager.io", "certificates/status", "Certificate")]]],
      options
    );
    expect(sections).toEqual([]);
  });
});

describe("list routes", () => {
  const all = [
    r("gateway.networking.k8s.io", "gateways", "Gateway"),
    r("networking.istio.io", "gateways", "Gateway"),
    r("velero.io", "backups", "Backup"),
    r("postgresql.cnpg.io", "backups", "Backup"),
    r("postgresql.cnpg.io", "clusters", "Cluster"),
    r("", "services", "Service"),
    r("serving.knative.dev", "services", "Service"),
    r("cert-manager.io", "certificates", "Certificate"),
  ];

  test("unique plurals stay plain", () => {
    expect(listResourceName(all[7], all)).toBe("certificates");
  });

  test("the group that wins the plain name keeps it, the others are qualified", () => {
    expect(listResourceName(all[0], all)).toBe("gateways");
    expect(listResourceName(all[1], all)).toBe("gateways.networking.istio.io");
    // Same rank: alphabetical, like the backend.
    expect(listResourceName(all[3], all)).toBe("backups");
    expect(listResourceName(all[2], all)).toBe("backups.velero.io");
    expect(listResourceName(all[5], all)).toBe("services");
    expect(listResourceName(all[6], all)).toBe("services.serving.knative.dev");
  });

  test("plurals that are app pages are qualified", () => {
    expect(listResourceName(all[4], all)).toBe("clusters.postgresql.cnpg.io");
  });
});
