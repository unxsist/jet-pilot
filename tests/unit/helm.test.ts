import { describe, test, assert } from "vitest";
import {
  changedValuePaths,
  chartsFromArtifactHub,
  chartsFromRepoSearch,
  describePaths,
  goTimeToIso,
  groupByKind,
  installArgs,
  mergeChartResults,
  namespaceProblem,
  objectHealth,
  parseInstallOutput,
  parseManifest,
  pluralKindLabel,
  releaseNameProblem,
  releaseRow,
  releaseStatus,
  releasesFromCli,
  repoNameProblem,
  repoUrlProblem,
  sortReleases,
  splitNotes,
  suggestRepoName,
  timeAgo,
  valuesYaml,
  type ArtifactHubChart,
  type HelmRelease,
} from "../../src/lib/helm";

const release = (name: string, namespace: string, status = "deployed"): HelmRelease => ({
  name,
  namespace,
  revision: 1,
  status,
  chart: name,
  chartVersion: "1.0.0",
  appVersion: "1.0.0",
  updated: "2026-10-12T08:15:30.123Z",
  description: "",
});

describe("release status", () => {
  test("statuses read as words with a tone", () => {
    assert.deepEqual(releaseStatus("deployed"), { label: "Deployed", tone: "success", busy: false, problem: false });
    assert.deepEqual(releaseStatus("failed"), { label: "Failed", tone: "destructive", busy: false, problem: true });
    assert.deepEqual(releaseStatus("pending-upgrade"), { label: "Upgrading", tone: "warning", busy: true, problem: true });
    assert.equal(releaseStatus("pending-install").label, "Installing");
    assert.equal(releaseStatus("pending-rollback").label, "Rolling back");
    assert.equal(releaseStatus("uninstalling").tone, "warning");
    assert.deepEqual(releaseStatus("superseded"), { label: "Superseded", tone: "muted", busy: false, problem: false });
    assert.equal(releaseStatus("").label, "Unknown");
    assert.equal(releaseStatus("something-new").label, "Something new");
  });

  test("releases sort by name, namespace, then cluster", () => {
    const rows = [
      releaseRow(release("web", "b"), "prod", ""),
      releaseRow(release("api", "a"), "prod", ""),
      releaseRow(release("web", "a"), "staging", ""),
      releaseRow(release("web", "a"), "prod", ""),
    ];
    assert.deepEqual(
      sortReleases(rows).map((r) => `${r.name}/${r.namespace}/${r.metadata.context}`),
      ["api/a/prod", "web/a/prod", "web/a/staging", "web/b/prod"]
    );
  });

  test("rows change version only when the release does", () => {
    const a = releaseRow(release("web", "a"), "prod", "/k");
    const b = releaseRow({ ...release("web", "a"), status: "failed" }, "prod", "/k");
    assert.notEqual(a.__rowVersion, b.__rowVersion);
    assert.deepEqual(a.metadata, { context: "prod", kubeConfig: "/k", name: "web", namespace: "a" });
  });

  test("helm list output is read as releases (CLI fallback)", () => {
    const [row] = releasesFromCli([
      { name: "web", namespace: "a", revision: "7", updated: "2026-10-12 08:15:30.123456789 +0200 CEST", status: "deployed", chart: "web-app-1.2.3", app_version: "2.0" },
    ]);
    assert.equal(row.revision, 7);
    assert.equal(row.chart, "web-app");
    assert.equal(row.chartVersion, "1.2.3");
    assert.equal(row.updated, "2026-10-12T06:15:30.123Z");
    assert.isNull(goTimeToIso("yesterday"));
  });

  test("relative times", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    assert.equal(timeAgo("2026-10-14T10:00:00Z", now), "2 hours ago");
    assert.equal(timeAgo("2026-10-14T11:59:50Z", now), "just now");
    assert.equal(timeAgo(Date.parse("2026-10-04T12:00:00Z") / 1000, now), "10 days ago");
    assert.equal(timeAgo(null, now), "");
    assert.equal(timeAgo("nonsense", now), "");
  });
});

describe("values", () => {
  test("changed paths between revisions", () => {
    const before = { image: { repository: "x", tag: "v1" }, replicaCount: 3, list: [1, 2], gone: true };
    const after = { image: { repository: "x", tag: "v2" }, replicaCount: 4, list: [1, 2], added: { a: 1 } };
    assert.deepEqual(changedValuePaths(before, after), ["added", "gone", "image.tag", "replicaCount"]);
    assert.deepEqual(changedValuePaths({ a: [1] }, { a: [1, 2] }), ["a"]);
    assert.deepEqual(changedValuePaths({}, {}), []);
  });

  test("paths read as a short sentence", () => {
    assert.equal(describePaths(["image.tag"]), "image.tag");
    assert.equal(describePaths(["image.tag", "replicaCount"]), "image.tag and replicaCount");
    assert.equal(describePaths(["a", "b", "c", "d"]), "a, b and 2 more");
    assert.equal(describePaths([]), "");
  });

  test("values as YAML", () => {
    assert.equal(valuesYaml({}), "");
    assert.equal(valuesYaml(null), "");
    assert.equal(valuesYaml({ image: { tag: "v1" }, replicaCount: 2 }), "image:\n  tag: v1\nreplicaCount: 2\n");
  });
});

describe("manifests", () => {
  const manifest = `---
# Source: web/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
---
# Source: web/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: other
---
# Source: web/templates/rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: web-reader
---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: b-config
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: a-config
---
this: [is not valid
---
# only a comment
`;

  test("objects are parsed with their template and namespace", () => {
    const objects = parseManifest(manifest, "apps");
    assert.deepEqual(objects[0], { apiVersion: "v1", kind: "Service", name: "web", namespace: "apps", source: "web/templates/service.yaml" });
    assert.equal(objects[1].namespace, "other");
    assert.equal(objects[2].namespace, "");
    assert.deepEqual(objects.map((o) => o.name), ["web", "web", "web-reader", "b-config", "a-config"]);
  });

  test("grouped by kind, workloads first", () => {
    const groups = groupByKind(parseManifest(manifest, "apps"));
    assert.deepEqual(groups.map((g) => g.kind), ["Deployment", "Service", "ConfigMap", "ClusterRole"]);
    assert.deepEqual(groups[2].objects.map((o) => o.name), ["a-config", "b-config"]);
    assert.deepEqual(
      groupByKind([{ kind: "Zeta", name: "z" }, { kind: "Alpha", name: "a" }]).map((g) => g.kind),
      ["Alpha", "Zeta"]
    );
  });

  test("kind labels", () => {
    assert.equal(pluralKindLabel("Deployment", 2), "Deployments");
    assert.equal(pluralKindLabel("Ingress", 2), "Ingresses");
    assert.equal(pluralKindLabel("NetworkPolicy", 3), "NetworkPolicies");
    assert.equal(pluralKindLabel("Service", 1), "Service");
  });

  test("live health of release objects", () => {
    assert.deepEqual(objectHealth("Deployment", null), { label: "Missing", tone: "warning" });
    assert.deepEqual(objectHealth("Deployment", { spec: { replicas: 3 }, status: { readyReplicas: 3 } }), { label: "Ready", tone: "success" });
    assert.deepEqual(objectHealth("Deployment", { spec: { replicas: 3 }, status: { readyReplicas: 2 } }), { label: "2/3 ready", tone: "warning" });
    assert.equal(objectHealth("StatefulSet", { spec: { replicas: 2 }, status: {} }).tone, "destructive");
    assert.equal(objectHealth("Deployment", { spec: { replicas: 0 }, status: {} }).label, "Scaled to 0");
    assert.equal(objectHealth("DaemonSet", { status: { numberReady: 4, desiredNumberScheduled: 4 } }).label, "Ready");
    assert.equal(objectHealth("Job", { status: { conditions: [{ type: "Failed", status: "True" }] } }).label, "Failed");
    assert.equal(objectHealth("Job", { status: { succeeded: 1 } }).label, "Complete");
    assert.equal(objectHealth("PersistentVolumeClaim", { status: { phase: "Pending" } }).tone, "warning");
  });
});

describe("chart search", () => {
  const repos = [
    { name: "bitnami", url: "https://charts.bitnami.com/bitnami/" },
    { name: "jetstack", url: "https://charts.jetstack.io" },
  ];
  const hub: ArtifactHubChart[] = [
    {
      packageId: "p1", name: "redis", description: "Redis", version: "19.6.4", appVersion: "7.2.5",
      repoName: "bitnami", repoDisplayName: "Bitnami", repoUrl: "https://charts.bitnami.com/bitnami",
      logoImageId: "logo-1", official: false, verifiedPublisher: true, cncf: false, deprecated: false, signed: true, stars: 1,
    },
    {
      packageId: "p2", name: "redis-ha", description: "HA", version: "4.27.6", appVersion: "7.2.4",
      repoName: "dandydev", repoDisplayName: null, repoUrl: "https://dandydeveloper.github.io/charts",
      logoImageId: null, official: false, verifiedPublisher: false, cncf: false, deprecated: false, signed: false, stars: 1,
    },
  ];

  test("repository results", () => {
    const [entry] = chartsFromRepoSearch(
      [{ name: "bitnami/redis", version: "19.6.4", app_version: "7.2.5", description: "DEPRECATED Redis" }],
      repos
    );
    assert.equal(entry.reference, "bitnami/redis");
    assert.equal(entry.name, "redis");
    assert.equal(entry.repoUrl, "https://charts.bitnami.com/bitnami/");
    assert.isTrue(entry.deprecated);
  });

  test("Artifact Hub results use your repository when you have it", () => {
    const [redis, ha] = chartsFromArtifactHub(hub, repos);
    assert.equal(redis.localRepo, "bitnami");
    assert.equal(redis.reference, "bitnami/redis");
    assert.equal(redis.repoLabel, "Bitnami");
    assert.isTrue(redis.verified);
    assert.isUndefined(ha.localRepo);
    assert.equal(ha.reference, "dandydev/redis-ha");
    assert.equal(ha.repoLabel, "dandydev");
  });

  test("results in your repositories gain Artifact Hub's mark and logo", () => {
    const local = chartsFromRepoSearch([{ name: "bitnami/redis", version: "19.6.4" }], repos);
    const merged = mergeChartResults(local, chartsFromArtifactHub(hub, repos));
    assert.equal(merged.local[0].logoImageId, "logo-1");
    assert.isTrue(merged.local[0].verified);
    assert.deepEqual(merged.hub.map((c) => c.name), ["redis-ha"]);
  });
});

describe("repositories and installs", () => {
  const repos = [{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }];

  test("repository names and URLs are validated", () => {
    assert.equal(repoNameProblem("", repos), "Give the repository a name");
    assert.match(repoNameProblem("my repo"), /Letters/);
    assert.match(repoNameProblem("bitnami", repos), /already/);
    assert.equal(repoNameProblem("grafana", repos), "");
    assert.equal(repoUrlProblem("https://grafana.github.io/helm-charts", repos), "");
    assert.match(repoUrlProblem("oci://registry-1.docker.io/bitnamicharts"), /OCI/);
    assert.match(repoUrlProblem("ftp://x.example"), /https/);
    assert.equal(repoUrlProblem("not a url"), "That isn't a URL");
    assert.equal(repoUrlProblem("http://charts.bitnami.com/bitnami/", repos), "This is bitnami");
  });

  test("repository names suggested for Artifact Hub repositories", () => {
    assert.equal(suggestRepoName("prometheus-community", repos), "prometheus-community");
    assert.equal(suggestRepoName("bitnami", repos), "bitnami-2");
    assert.equal(suggestRepoName("My Charts!", []), "my-charts");
  });

  test("release and namespace names", () => {
    assert.equal(releaseNameProblem("redis"), "");
    assert.equal(releaseNameProblem("my.redis-1"), "");
    assert.match(releaseNameProblem("Redis"), /Lowercase/);
    assert.match(releaseNameProblem("-redis"), /Lowercase/);
    assert.match(releaseNameProblem("a".repeat(54)), /53/);
    assert.equal(namespaceProblem("cache"), "");
    assert.match(namespaceProblem("my.cache"), /Lowercase/);
    assert.equal(namespaceProblem(""), "Pick a namespace");
  });

  test("helm install arguments", () => {
    const base = { release: "cache", chart: "bitnami/redis", version: "19.6.4", namespace: "cache", createNamespace: true, context: "prod", kubeConfig: "/k" };
    assert.deepEqual(installArgs({ ...base, dryRun: true, atomic: true }), [
      "install", "cache", "bitnami/redis", "--version=19.6.4", "--namespace=cache", "--create-namespace",
      "--dry-run", "--output=json", "--kube-context=prod", "--kubeconfig=/k",
    ]);
    assert.deepEqual(installArgs({ ...base, createNamespace: false, kubeConfig: "", atomic: true }), [
      "install", "cache", "bitnami/redis", "--version=19.6.4", "--namespace=cache",
      "--atomic", "--timeout=10m", "--output=json", "--kube-context=prod",
    ]);
  });

  test("helm install output", () => {
    const result = parseInstallOutput(
      'WARNING: something\n{"name":"cache","version":1,"info":{"status":"deployed","notes":"Hi"},"manifest":"---\\nkind: Service","hooks":[{"name":"t","kind":"Pod","events":["test"]}]}'
    );
    assert.deepEqual(result, {
      status: "deployed",
      revision: 1,
      manifest: "---\nkind: Service",
      notes: "Hi",
      hooks: [{ name: "t", kind: "Pod", events: ["test"] }],
    });
    assert.isNull(parseInstallOutput("Error: nope"));
  });
});

describe("notes", () => {
  test("commands become copyable blocks", () => {
    const blocks = splitNotes(
      [
        "1. Get the application URL by running these commands:",
        '  export POD_NAME=$(kubectl get pods -l "app=web" -o jsonpath="{.items[0].metadata.name}")',
        "  kubectl port-forward $POD_NAME 8080:80",
        "",
        "2. Kind regards, and visit http://127.0.0.1:8080",
        "  helm upgrade web repo/web \\",
        "    --set a=b",
      ].join("\n")
    );
    assert.deepEqual(blocks.map((b) => b.type), ["text", "command", "text", "command"]);
    assert.equal(
      blocks[1].text,
      'export POD_NAME=$(kubectl get pods -l "app=web" -o jsonpath="{.items[0].metadata.name}")\nkubectl port-forward $POD_NAME 8080:80'
    );
    assert.equal(blocks[3].text, "helm upgrade web repo/web \\\n  --set a=b");
    assert.isTrue(blocks[2].text.startsWith("2. Kind regards"));
  });
});
