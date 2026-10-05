import { describe, test, assert } from "vitest";
import {
  baseName,
  debugPodNameFromOutput,
  isPodRef,
  kubectlCopyArgs,
  kubectlDebugPodCommand,
  kubectlNodeShellCommand,
  labelSelectorToString,
  mapSelectorToString,
  podNameOf,
  workloadSelector,
} from "../../src/lib/workloads";
import {
  controllerRevisions,
  deploymentRevisions,
  rolloutArgs,
  rolloutProgress,
} from "../../src/lib/rollout";
import {
  chartVersionsByRepo,
  hasDiffPlugin,
  normalizeValues,
  parseChartField,
  stripAnsi,
} from "../../src/lib/helm";

describe("label selectors", () => {
  test("matchLabels and every expression operator", () => {
    assert.equal(
      labelSelectorToString({
        matchLabels: { tier: "api", app: "web" },
        matchExpressions: [
          { key: "env", operator: "In", values: ["prod", "acc"] },
          { key: "track", operator: "NotIn", values: ["canary"] },
          { key: "managed", operator: "Exists" },
          { key: "legacy", operator: "DoesNotExist" },
        ],
      }),
      "app=web,tier=api,env in (acc,prod),track notin (canary),managed,!legacy"
    );
  });

  test("empty selectors produce nothing", () => {
    assert.equal(labelSelectorToString(undefined), "");
    assert.equal(labelSelectorToString({}), "");
    assert.equal(mapSelectorToString(null), "");
  });

  test("selector per kind", () => {
    const spec = { selector: { matchLabels: { app: "web" } } };
    for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]) {
      assert.equal(workloadSelector({ kind, spec }), "app=web");
    }
    assert.equal(
      workloadSelector({ kind: "Service", spec: { selector: { app: "web" } } }),
      "app=web"
    );
    // Service without selector (external endpoints) / unsupported kinds.
    assert.isNull(workloadSelector({ kind: "Service", spec: {} }));
    assert.isNull(workloadSelector({ kind: "CronJob", spec }));
    assert.isNull(workloadSelector({ kind: "Pod" }));
  });

  test("pod references", () => {
    assert.isTrue(isPodRef("web-0"));
    assert.isTrue(isPodRef("pod/web-0"));
    assert.isFalse(isPodRef("deployment/web"));
    assert.equal(podNameOf("pods/web-0"), "web-0");
  });
});

describe("debug and copy commands", () => {
  const cluster = { context: "prod", namespace: "shop", kubeConfig: "/kc" };

  test("ephemeral debug container targets a container", () => {
    assert.deepEqual(
      kubectlDebugPodCommand({ pod: "web-0", image: "busybox:1.36", target: "app", cluster }),
      [
        "kubectl", "debug", "--stdin", "--tty", "web-0",
        "--context=prod", "--namespace=shop", "--kubeconfig=/kc",
        "--image=busybox:1.36", "--target=app", "--profile=general", "--", "sh",
      ]
    );
  });

  test("node shell chroots into the host", () => {
    const argv = kubectlNodeShellCommand({ node: "n1", image: "busybox", cluster, chroot: true });
    assert.include(argv, "node/n1");
    assert.include(argv, "--profile=sysadmin");
    assert.deepEqual(argv.slice(-4), ["--", "chroot", "/host", "sh"]);
  });

  test("debug pod name is read from kubectl output", () => {
    assert.equal(
      debugPodNameFromOutput(
        "Creating debugging pod node-debugger-n1-x7k2p with container debugger on node n1.\r\n"
      ),
      "node-debugger-n1-x7k2p"
    );
    assert.isNull(debugPodNameFromOutput("no pod here"));
  });

  test("kubectl cp in both directions", () => {
    const base = { pod: "web-0", namespace: "shop", container: "app", remotePath: "/tmp/a.log", localPath: "/home/me/a.log", cluster };
    assert.deepEqual(kubectlCopyArgs({ ...base, direction: "download" }), [
      "cp", "shop/web-0:/tmp/a.log", "/home/me/a.log", "--container=app", "--context=prod", "--kubeconfig=/kc",
    ]);
    assert.deepEqual(kubectlCopyArgs({ ...base, direction: "upload" }).slice(1, 3), [
      "/home/me/a.log", "shop/web-0:/tmp/a.log",
    ]);
    assert.equal(baseName("/var/log/app.log"), "app.log");
    assert.equal(baseName("C:\\Users\\me\\dump.bin"), "dump.bin");
  });
});

describe("rollout revisions", () => {
  const deployment = {
    kind: "Deployment",
    metadata: { uid: "dep", annotations: { "deployment.kubernetes.io/revision": "3" } },
  };
  const rs = (name: string, revision: string, image: string, owner = "dep") => ({
    metadata: {
      name,
      creationTimestamp: "2024-01-0" + revision + "T00:00:00Z",
      annotations: {
        "deployment.kubernetes.io/revision": revision,
        "kubernetes.io/change-cause": `set image ${image}`,
      },
      ownerReferences: [{ uid: owner, controller: true }],
    },
    spec: {
      template: {
        metadata: { labels: { app: "web", "pod-template-hash": name } },
        spec: { containers: [{ name: "app", image }] },
      },
    },
    status: { replicas: revision === "3" ? 2 : 0, readyReplicas: revision === "3" ? 2 : 0 },
  });

  test("ReplicaSets owned by the deployment, newest first", () => {
    const revisions = deploymentRevisions(deployment, [
      rs("web-a", "1", "web:1"),
      rs("web-c", "3", "web:3"),
      rs("web-b", "2", "web:2"),
      rs("other", "9", "other:1", "someone-else"),
    ]);
    assert.deepEqual(revisions.map((r) => r.revision), [3, 2, 1]);
    assert.isTrue(revisions[0].current);
    assert.isFalse(revisions[1].current);
    assert.deepEqual(revisions[1].images, ["web:2"]);
    assert.equal(revisions[1].changeCause, "set image web:2");
    assert.equal(revisions[0].replicas, 2);
    // The per-revision hash label is diff noise.
    assert.deepEqual(revisions[0].template.metadata?.labels, { app: "web" });
  });

  test("ControllerRevisions of a StatefulSet", () => {
    const sts = { kind: "StatefulSet", metadata: { uid: "sts" }, status: { updateRevision: "db-2" } };
    const cr = (name: string, revision: number) => ({
      metadata: { name, ownerReferences: [{ uid: "sts" }] },
      revision,
      data: { spec: { template: { spec: { containers: [{ name: "db", image: `pg:${revision}` }] } } } },
    });
    const revisions = controllerRevisions(sts, [cr("db-1", 1), cr("db-2", 2)]);
    assert.deepEqual(revisions.map((r) => [r.revision, r.current]), [[2, true], [1, false]]);
    assert.deepEqual(revisions[1].images, ["pg:1"]);

    // DaemonSets: the highest revision is current.
    const ds = { kind: "DaemonSet", metadata: { uid: "sts" } };
    assert.isTrue(controllerRevisions(ds, [cr("a", 1), cr("b", 4)])[0].current);
  });

  test("rollout progress", () => {
    const base = { kind: "Deployment", metadata: { generation: 2 }, spec: { replicas: 3 } };
    assert.equal(
      rolloutProgress({ ...base, status: { observedGeneration: 2, replicas: 3, updatedReplicas: 3, availableReplicas: 3, readyReplicas: 3 } }).phase,
      "complete"
    );
    const progressing = rolloutProgress({ ...base, status: { observedGeneration: 2, replicas: 4, updatedReplicas: 2, availableReplicas: 3 } });
    assert.equal(progressing.phase, "progressing");
    assert.equal(progressing.message, "2 of 3 updated replicas");
    assert.closeTo(progressing.ratio, 2 / 3, 0.001);
    assert.equal(rolloutProgress({ ...base, spec: { replicas: 3, paused: true }, status: {} }).phase, "paused");
    assert.equal(
      rolloutProgress({ ...base, status: { conditions: [{ type: "Progressing", reason: "ProgressDeadlineExceeded" }] } }).phase,
      "failed"
    );
    assert.equal(
      rolloutProgress({ ...base, status: { observedGeneration: 1 } }).phase,
      "progressing"
    );
    const ds = rolloutProgress({ kind: "DaemonSet", status: { desiredNumberScheduled: 4, updatedNumberScheduled: 4, numberAvailable: 4, numberReady: 4 } });
    assert.equal(ds.phase, "complete");
    assert.deepEqual(rolloutArgs("undo", "Deployment", "web", ["--to-revision=2"]), [
      "rollout", "undo", "deployment/web", "--to-revision=2",
    ]);
  });
});

describe("helm", () => {
  test("chart field is split into name and version", () => {
    assert.deepEqual(parseChartField("kube-prometheus-stack-61.3.2"), { name: "kube-prometheus-stack", version: "61.3.2" });
    assert.deepEqual(parseChartField("cert-manager-v1.15.1"), { name: "cert-manager", version: "v1.15.1" });
    assert.deepEqual(parseChartField("app-1.0.0-rc.1"), { name: "app", version: "1.0.0-rc.1" });
    assert.deepEqual(parseChartField("weird"), { name: "weird", version: "" });
  });

  test("search results grouped by repository", () => {
    const byRepo = chartVersionsByRepo(
      [
        { name: "bitnami/redis", version: "19.6.4" },
        { name: "bitnami/redis", version: "19.6.3" },
        { name: "other/redis", version: "1.0.0" },
        { name: "bitnami/redis-cluster", version: "10.0.0" },
      ],
      "redis"
    );
    assert.deepEqual([...byRepo.keys()], ["bitnami/redis", "other/redis"]);
    assert.equal(byRepo.get("bitnami/redis")?.length, 2);
  });

  test("diff plugin detection and values", () => {
    assert.isTrue(hasDiffPlugin("NAME\tVERSION\tDESCRIPTION\ndiff\t3.9.4\tPreview helm upgrade changes as a diff\n"));
    assert.isFalse(hasDiffPlugin("NAME\tVERSION\tDESCRIPTION\nsecrets\t4.1.1\tdiff for secrets\n"));
    assert.equal(normalizeValues("null\n"), "");
    assert.equal(stripAnsi("\x1b[32m+ added\x1b[0m"), "+ added");
  });
});
