import { describe, expect, test } from "vitest";
import {
  claimFindings,
  cronJobFindings,
  deploymentFindings,
  indexEvents,
  jobFindings,
  nodeFindings,
  podFindings,
  withEvents,
} from "@/lib/health/problems/detect";
import { detectProblems, fingerprintOf, fingerprintScope, podsWords, topOwner } from "@/lib/health/problems/group";
import { managedWords, managerOf } from "@/lib/health/problems/managed";
import { isActive, partition, prune, snooze, unsnooze } from "@/lib/health/problems/snooze";
import {
  fixesFor,
  memoryLimitOf,
  memoryPatch,
  memoryTarget,
  retryJob,
  revertPatch,
  suggestMemoryLimit,
  validMemory,
} from "@/lib/health/problems/fixes";
import {
  claimWords,
  configWords,
  createWords,
  evictionWords,
  exitWords,
  mountWords,
  probeWords,
  pullWords,
  schedulingWords,
} from "@/lib/health/problems/words";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const CONTEXT = { context: "prod", kubeConfig: "/kube/config" };

let uid = 0;
const meta = (name: string, namespace?: string, extra: Record<string, unknown> = {}) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: `uid-${++uid}`,
  creationTimestamp: ago(3600),
  ...CONTEXT,
  ...extra,
});

const running = (name = "app", extra: Record<string, unknown> = {}) => ({
  name,
  image: `acme/${name}:1.0`,
  ready: true,
  restartCount: 0,
  state: { running: { startedAt: ago(3000) } },
  ...extra,
});

function pod(name: string, statuses: any[], options: { owner?: any; labels?: Record<string, string>; spec?: any; status?: any; metadata?: any } = {}) {
  return {
    kind: "Pod",
    metadata: meta(name, "shop", {
      labels: options.labels,
      ownerReferences: options.owner ? [{ controller: true, ...options.owner }] : undefined,
      ...options.metadata,
    }),
    spec: {
      restartPolicy: "Always",
      containers: statuses.map((s) => ({ name: s.name, image: s.image, resources: { limits: { memory: "512Mi" } } })),
      ...options.spec,
    },
    status: {
      phase: "Running",
      startTime: ago(3000),
      conditions: [
        { type: "PodScheduled", status: "True", lastTransitionTime: ago(3000) },
        { type: "Ready", status: statuses.every((s) => s.ready) ? "True" : "False", lastTransitionTime: ago(1200) },
      ],
      containerStatuses: statuses,
      ...options.status,
    },
  };
}

const crashing = (exitCode = 1, reason = "Error") =>
  running("app", {
    ready: false,
    restartCount: 14,
    state: { waiting: { reason: "CrashLoopBackOff" } },
    lastState: { terminated: { exitCode, reason, finishedAt: ago(300) } },
  });

const deployment = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "Deployment",
  metadata: meta(name, "shop"),
  spec: { replicas: 3 },
  status: {},
  ...extra,
});

const rsPod = (podName: string, deploymentName: string, statuses: any[], hash = "7d9f8") =>
  pod(podName, statuses, {
    owner: { kind: "ReplicaSet", name: `${deploymentName}-${hash}`, apiVersion: "apps/v1" },
    labels: { "pod-template-hash": hash },
  });

const empty = { pods: [], deployments: [], jobs: [], cronJobs: [], nodes: [], claims: [] };

describe("words", () => {
  test("exit codes", () => {
    expect(exitWords(1)).toBe("Exits with code 1");
    expect(exitWords(137)).toBe("Killed (exit code 137)");
    expect(exitWords(undefined)).toBe("Keeps exiting");
  });

  test("missing config", () => {
    expect(configWords('secret "ledger-signing-key" not found')).toEqual({
      label: "Missing a Secret",
      short: "Secret ledger-signing-key doesn't exist",
    });
    expect(configWords('configmap "flags" not found').label).toBe("Missing a ConfigMap");
    expect(configWords("couldn't find key password in Secret shop/db")).toEqual({
      label: "Missing a key",
      short: "Secret db has no key password",
    });
    expect(configWords("container has runAsNonRoot and image will run as root")).toEqual({
      label: "Configuration error",
      short: "Container has runAsNonRoot and image will run as root",
    });
  });

  test("the scheduler's dominant reason", () => {
    expect(
      schedulingWords(
        "0/4 nodes are available: 4 Insufficient memory. preemption: 0/4 nodes are available: 4 No preemption victims found for incoming pod."
      )
    ).toBe("No node has enough memory");
    expect(
      schedulingWords("0/5 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 4 Insufficient cpu.")
    ).toBe("No node has enough CPU");
    expect(schedulingWords("0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.")).toBe(
      "No node matches its node selector"
    );
    expect(schedulingWords("0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.")).toBe(
      "Its volume claim isn't bound"
    );
    expect(schedulingWords("0/2 nodes are available: 2 node(s) had volume node affinity conflict.")).toBe("Its volume is in another zone");
    expect(schedulingWords(undefined)).toBe("No node can run it yet");
  });

  test("evictions, probes, pulls, mounts, claims, creation", () => {
    expect(evictionWords("The node was low on resource: memory. Threshold quantity: 100Mi.")).toBe("The node ran low on memory");
    expect(evictionWords("The node was low on resource: ephemeral-storage.")).toBe("The node ran low on disk space");
    expect(probeWords("Readiness probe failed: HTTP probe failed with statuscode: 503")).toEqual({
      type: "Readiness",
      short: "Readiness probe gets HTTP 503",
    });
    expect(probeWords('Liveness probe failed: Get "http://10.0.0.1:8080/healthz": dial tcp 10.0.0.1:8080: connect: connection refused')?.short).toBe(
      "Liveness probe can't connect"
    );
    expect(probeWords("Back-off restarting failed container")).toBeNull();
    expect(pullWords("acme/api:9", "rpc error: code = NotFound desc = failed to resolve reference: not found")).toBe("acme/api:9 doesn't exist");
    expect(pullWords("acme/api:9", "pull access denied, repository does not exist or may require authorization")).toBe("acme/api:9 doesn't exist");
    expect(pullWords("acme/api:9", "failed to authorize: 401 Unauthorized")).toBe("Not allowed to pull acme/api:9");
    expect(mountWords('MountVolume.SetUp failed for volume "certs" : secret "api-tls" not found')).toBe("Secret api-tls doesn't exist");
    expect(claimWords('storageclass.storage.k8s.io "fast-ssd" not found')).toBe("Storage class fast-ssd doesn't exist");
    expect(createWords('pods "api-7d9-x" is forbidden: exceeded quota: compute, requested: limits.memory=1Gi')).toBe(
      "Over its namespace's resource quota"
    );
    expect(createWords('pods "api-7d9-x" is forbidden: error looking up service account shop/api: serviceaccount "api" not found')).toBe(
      "Service account api doesn't exist"
    );
  });
});

describe("pod findings", () => {
  test("healthy pods have none", () => {
    expect(podFindings(pod("ok", [running()]), NOW)).toEqual([]);
    expect(podFindings(pod("done", [running()], { status: { phase: "Succeeded" } }), NOW)).toEqual([]);
  });

  test("a crash loop, with its exit code and when it started", () => {
    const [finding] = podFindings(pod("api", [crashing()]), NOW);
    expect(finding).toMatchObject({ kind: "crashloop", container: "app", short: "Exits with code 1", exitCode: 1, restarts: 14 });
    expect(finding!.since).toBe(Date.parse(ago(1200)));
    expect(finding!.lastSeen).toBe(Date.parse(ago(300)));
  });

  test("out of memory: in a crash loop, terminated, or running again after a recent kill", () => {
    expect(podFindings(pod("a", [crashing(137, "OOMKilled")]), NOW)[0]).toMatchObject({
      kind: "oom",
      short: "Over its 512Mi memory limit",
      memoryLimit: "512Mi",
    });
    const terminated = running("app", { ready: false, state: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: ago(60) } } });
    expect(podFindings(pod("b", [terminated]), NOW)[0]?.kind).toBe("oom");
    const recovered = running("app", { restartCount: 1, lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: ago(600) } } });
    expect(podFindings(pod("c", [recovered]), NOW)[0]?.kind).toBe("oom");
    const longAgo = running("app", { restartCount: 1, lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: ago(7200) } } });
    expect(podFindings(pod("d", [longAgo]), NOW)).toEqual([]);
  });

  test("repeated recent crashes count; a single old one doesn't", () => {
    const flapping = running("app", { restartCount: 5, lastState: { terminated: { exitCode: 143, reason: "Error", finishedAt: ago(240) } } });
    expect(podFindings(pod("a", [flapping]), NOW)[0]).toMatchObject({ kind: "crashloop", short: "Restarted 5 times, last 4m ago" });
    const once = running("app", { restartCount: 1, lastState: { terminated: { exitCode: 1, reason: "Error", finishedAt: ago(240) } } });
    expect(podFindings(pod("b", [once]), NOW)).toEqual([]);
  });

  test("image pulls, missing config and runtime errors", () => {
    const pull = running("app", { ready: false, state: { waiting: { reason: "ImagePullBackOff", message: "Back-off" } } });
    expect(podFindings(pod("a", [pull]), NOW)[0]).toMatchObject({ kind: "image-pull", short: "acme/app:1.0" });
    const config = running("app", { ready: false, state: { waiting: { reason: "CreateContainerConfigError", message: 'secret "db" not found' } } });
    expect(podFindings(pod("b", [config]), NOW)[0]).toMatchObject({ kind: "config", label: "Missing a Secret", short: "Secret db doesn't exist" });
    const runtime = running("app", { ready: false, state: { waiting: { reason: "RunContainerError", message: "exec: not found" } } });
    expect(podFindings(pod("c", [runtime]), NOW)[0]).toMatchObject({ kind: "cant-start", short: "Exec: not found" });
  });

  test("a failing init container blocks the rest; a running sidecar doesn't count", () => {
    const failing = pod("a", [running("app", { ready: false, state: { waiting: { reason: "PodInitializing" } } })], {
      spec: { initContainers: [{ name: "migrate" }, { name: "seed" }] },
      status: {
        phase: "Pending",
        initContainerStatuses: [
          running("migrate", { ready: false, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { exitCode: 2 } } }),
          running("seed", { ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }),
        ],
      },
    });
    const findings = podFindings(failing, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "crashloop", container: "migrate", init: true, exitCode: 2 });

    const sidecar = pod("b", [running()], {
      spec: { initContainers: [{ name: "proxy", restartPolicy: "Always" }] },
      status: { initContainerStatuses: [running("proxy")] },
    });
    expect(podFindings(sidecar, NOW)).toEqual([]);
  });

  test("unschedulable, with the scheduler's reason", () => {
    const pending = pod("a", [], {
      status: {
        phase: "Pending",
        containerStatuses: undefined,
        conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/4 nodes are available: 4 Insufficient memory.", lastTransitionTime: ago(900) }],
      },
    });
    expect(podFindings(pending, NOW)[0]).toMatchObject({ kind: "unschedulable", short: "No node has enough memory", since: Date.parse(ago(900)) });
  });

  test("stuck starting after five minutes of creating containers", () => {
    const creating = (seconds: number) =>
      pod("a", [running("app", { ready: false, state: { waiting: { reason: "ContainerCreating" } } })], {
        status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "True", lastTransitionTime: ago(seconds) }] },
      });
    expect(podFindings(creating(120), NOW)).toEqual([]);
    expect(podFindings(creating(900), NOW)[0]).toMatchObject({ kind: "stuck-starting", short: "Creating its containers for 15m" });
  });

  test("not ready: only containers with a readiness probe, after a minute", () => {
    const notReady = (seconds: number, probe = true) => {
      const p = pod("a", [running("app", { ready: false })], { spec: { containers: [{ name: "app", ...(probe ? { readinessProbe: {} } : {}) }] } });
      p.status.conditions[1]!.lastTransitionTime = ago(seconds);
      return p;
    };
    expect(podFindings(notReady(30), NOW)).toEqual([]);
    expect(podFindings(notReady(300), NOW)[0]).toMatchObject({ kind: "probe", short: "Its readiness probe doesn't pass" });
    expect(podFindings(notReady(300, false), NOW)).toEqual([]);
  });

  test("evicted, stuck terminating and failed pods", () => {
    const evicted = pod("a", [], { status: { phase: "Failed", reason: "Evicted", message: "The node was low on resource: memory.", containerStatuses: [] } });
    expect(podFindings(evicted, NOW)[0]).toMatchObject({ kind: "evicted", short: "The node ran low on memory" });

    const stuck = pod("b", [running()], { metadata: { deletionTimestamp: ago(600) } });
    expect(podFindings(stuck, NOW)[0]).toMatchObject({ kind: "stuck-terminating", short: "Its grace period ended 10m ago" });
    const terminating = pod("c", [running()], { metadata: { deletionTimestamp: ago(10) } });
    expect(podFindings(terminating, NOW)).toEqual([]);

    const failed = pod("d", [running("app", { state: { terminated: { exitCode: 3, finishedAt: ago(60) } } })], {
      spec: { restartPolicy: "Never" },
      status: { phase: "Failed" },
    });
    expect(podFindings(failed, NOW)[0]).toMatchObject({ kind: "crashloop", label: "Failed", exitCode: 3 });
    const jobPod = { ...failed, metadata: { ...failed.metadata, ownerReferences: [{ kind: "Job", name: "j" }] } };
    expect(podFindings(jobPod, NOW)).toEqual([]);
  });
});

describe("other findings", () => {
  const node = (conditions: any[]) => ({ kind: "Node", metadata: meta("node-1"), status: { conditions } });

  test("nodes not ready, not responding, or under pressure", () => {
    expect(nodeFindings(node([{ type: "Ready", status: "False", message: "container runtime is down", lastTransitionTime: ago(60) }]))[0]).toMatchObject({
      kind: "node-not-ready",
      label: "Not ready",
      short: "Container runtime is down",
    });
    expect(nodeFindings(node([{ type: "Ready", status: "Unknown" }]))[0]).toMatchObject({ label: "Not responding" });
    const pressure = nodeFindings(node([{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "True" }, { type: "MemoryPressure", status: "False" }]));
    expect(pressure).toEqual([expect.objectContaining({ kind: "node-pressure", label: "Low on disk" })]);
    expect(nodeFindings(node([{ type: "Ready", status: "True" }]))).toEqual([]);
  });

  test("Deployments: a stuck rollout, pods that can't be created; paused ones are fine", () => {
    const stuck = deployment("api", {
      status: { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "api-7d9" has timed out progressing.' }] },
    });
    expect(deploymentFindings(stuck)[0]).toMatchObject({ kind: "rollout-stuck" });
    const quota = deployment("api", { status: { conditions: [{ type: "ReplicaFailure", status: "True", message: "exceeded quota: compute" }] } });
    expect(deploymentFindings(quota)[0]).toMatchObject({ kind: "create-failed", short: "Over its namespace's resource quota" });
    expect(deploymentFindings({ ...stuck, spec: { paused: true } })).toEqual([]);
  });

  const job = (name: string, failedAt?: string, extra: Record<string, unknown> = {}) => ({
    kind: "Job",
    metadata: meta(name, "shop", { creationTimestamp: failedAt ?? ago(60), ...extra }),
    spec: { backoffLimit: 2 },
    status: failedAt
      ? { failed: 3, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", lastTransitionTime: failedAt }] }
      : { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
  });

  test("failed Jobs, unless a week old", () => {
    expect(jobFindings(job("migrate", ago(600)), NOW)[0]).toMatchObject({ kind: "job-failed", short: "Failed 3 times and gave up" });
    expect(jobFindings(job("migrate", ago(8 * 86400)), NOW)).toEqual([]);
    expect(jobFindings(job("migrate"), NOW)).toEqual([]);
  });

  test("CronJobs: the newest run decides; without runs, the schedule", () => {
    const cron = (status: any = {}, spec: any = {}) => ({ kind: "CronJob", metadata: meta("report", "shop"), spec, status });
    expect(cronJobFindings(cron(), [job("report-1", ago(7200)), job("report-2", ago(600))], NOW)[0]).toMatchObject({ kind: "cronjob-failed" });
    expect(cronJobFindings(cron(), [job("report-1", ago(7200)), job("report-2", undefined, { creationTimestamp: ago(60) })], NOW)).toEqual([]);
    expect(cronJobFindings(cron({ lastScheduleTime: ago(600), lastSuccessfulTime: ago(90000) }), [], NOW)[0]).toMatchObject({
      short: "The last success was 1d 1h ago",
    });
    expect(cronJobFindings(cron({ lastScheduleTime: ago(600), lastSuccessfulTime: ago(500) }), [], NOW)).toEqual([]);
    expect(cronJobFindings(cron({ lastScheduleTime: ago(600) }, { suspend: true }), [], NOW)).toEqual([]);
    expect(cronJobFindings(cron({ lastScheduleTime: ago(600), active: [{}] }), [], NOW)).toEqual([]);
  });

  test("claims: lost, or pending for over a minute", () => {
    const claim = (phase: string, created = ago(600)) => ({ kind: "PersistentVolumeClaim", metadata: meta("data", "shop", { creationTimestamp: created }), status: { phase } });
    expect(claimFindings(claim("Lost"), NOW)[0]?.kind).toBe("pvc-lost");
    expect(claimFindings(claim("Pending"), NOW)[0]?.kind).toBe("pvc-pending");
    expect(claimFindings(claim("Pending", ago(20)), NOW)).toEqual([]);
    expect(claimFindings(claim("Bound"), NOW)).toEqual([]);
  });
});

describe("events add detail", () => {
  const event = (name: string, reason: string, message: string, seconds = 60, kind = "Pod") => ({
    type: "Warning",
    reason,
    message,
    involvedObject: { kind, name, namespace: "shop" },
    lastTimestamp: ago(seconds),
  });

  test("which probe fails", () => {
    const notReady = { kind: "probe" as const, object: { kind: "Pod", name: "api-1", namespace: "shop" }, short: "Its readiness probe doesn't pass" };
    const index = indexEvents([event("api-1", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503")]);
    expect(withEvents(notReady, index, NOW)).toMatchObject({ label: "Readiness probe failing", short: "Readiness probe gets HTTP 503" });

    const crash = { kind: "crashloop" as const, object: notReady.object, short: "Killed (exit code 137)" };
    const liveness = indexEvents([event("api-1", "Unhealthy", "Liveness probe failed: Get http://x: context deadline exceeded")]);
    expect(withEvents(crash, liveness, NOW)).toMatchObject({ label: "Liveness probe failing", short: "Liveness probe times out" });
    const old = indexEvents([event("api-1", "Unhealthy", "Liveness probe failed: timeout", 3600)]);
    expect(withEvents(crash, old, NOW)).toBe(crash);
    // Readiness failures don't explain a crash.
    expect(withEvents(crash, index, NOW)).toBe(crash);
  });

  test("why a claim can't bind; normal events are ignored", () => {
    const pending = { kind: "pvc-pending" as const, object: { kind: "PersistentVolumeClaim", name: "data", namespace: "shop" }, short: "data isn't bound to a volume" };
    const index = indexEvents([
      event("data", "ProvisioningFailed", 'storageclass.storage.k8s.io "fast-ssd" not found', 60, "PersistentVolumeClaim"),
      { ...event("data", "Provisioning", "normal", 10, "PersistentVolumeClaim"), type: "Normal" },
    ]);
    expect(withEvents(pending, index, NOW).short).toBe("Storage class fast-ssd doesn't exist");
    expect(index.get("PersistentVolumeClaim/shop/data")).toHaveLength(1);
  });
});

describe("grouping", () => {
  test("pods group under their Deployment: one bad rollout is one problem", () => {
    const pods = [
      rsPod("api-7d9f8-a", "api", [crashing()]),
      rsPod("api-7d9f8-b", "api", [crashing(137, "OOMKilled")]),
      rsPod("api-7d9f8-c", "api", [running()]),
    ];
    const [problem, ...rest] = detectProblems({ ...empty, pods, deployments: [deployment("api")] }, NOW);
    expect(rest).toEqual([]);
    expect(problem).toMatchObject({
      kind: "oom",
      label: "Out of memory",
      subject: { kind: "Deployment", name: "api", namespace: "shop" },
      pods: { affected: 2, total: 3 },
      context: "prod",
    });
    expect(podsWords(problem!)).toBe("2 of 3 pods");
    expect(problem!.findings.map((f) => f.kind)).toEqual(["oom", "crashloop"]);
  });

  test("owners without a known Deployment stay their ReplicaSet; Jobs roll up to their CronJob", () => {
    const orphan = rsPod("old-7d9f8-a", "old", [crashing()]);
    const cronJob = { kind: "CronJob", metadata: meta("report", "shop"), spec: {}, status: {} };
    const job = { kind: "Job", metadata: meta("report-1", "shop", { ownerReferences: [{ kind: "CronJob", name: "report", controller: true }] }) };
    const jobPod = pod("report-1-x", [crashing()], { owner: { kind: "Job", name: "report-1" } });
    const owners = { deployments: new Map(), jobs: new Map([[["prod", "shop", "Job", "report-1"].join("\u0000"), job]]) };
    expect(topOwner(orphan, owners)).toMatchObject({ kind: "ReplicaSet", name: "old-7d9f8" });
    expect(topOwner(jobPod, owners)).toMatchObject({ kind: "CronJob", name: "report" });
    const problems = detectProblems({ ...empty, pods: [jobPod], jobs: [job], cronJobs: [cronJob] }, NOW);
    expect(problems.map((p) => `${p.subject.kind}/${p.subject.name}`)).toEqual(["CronJob/report"]);
  });

  test("a pending claim joins the workload waiting for it, as its cause", () => {
    const sts = { kind: "StatefulSet", name: "redis", apiVersion: "apps/v1" };
    const waiting = pod("redis-0", [], {
      owner: sts,
      spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-redis-0" } }] },
      status: { phase: "Pending", containerStatuses: undefined, conditions: [{ type: "PodScheduled", status: "False", message: "0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims." }] },
    });
    const claim = { kind: "PersistentVolumeClaim", metadata: meta("data-redis-0", "shop", { creationTimestamp: ago(600) }), status: { phase: "Pending" } };
    const unused = { kind: "PersistentVolumeClaim", metadata: meta("spare", "shop", { creationTimestamp: ago(600) }), status: { phase: "Pending" } };
    const problems = detectProblems({ ...empty, pods: [waiting], claims: [claim, unused] }, NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "pvc-pending", label: "Waiting for a volume", subject: { kind: "StatefulSet", name: "redis" } });
    expect(problems[0]!.findings.map((f) => f.kind)).toEqual(["pvc-pending", "unschedulable"]);
  });

  test("severity first, then the newest; fingerprints survive rollouts", () => {
    const node = { kind: "Node", metadata: meta("node-1"), status: { conditions: [{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "True", lastTransitionTime: ago(60) }] } };
    const olderCrash = rsPod("api-7d9f8-a", "api", [crashing()]);
    const newerCrash = rsPod("web-5c6b7-a", "web", [crashing()], "5c6b7");
    newerCrash.status.conditions[1]!.lastTransitionTime = ago(100);
    const problems = detectProblems({ ...empty, pods: [olderCrash, newerCrash], deployments: [deployment("api"), deployment("web")], nodes: [node] }, NOW);
    expect(problems.map((p) => p.subject.name)).toEqual(["web", "api", "node-1"]);

    const rolledOut = rsPod("api-a1b2c-z", "api", [crashing(137, "OOMKilled")], "a1b2c");
    const [after] = detectProblems({ ...empty, pods: [rolledOut], deployments: [deployment("api")] }, NOW);
    expect(after!.fingerprint).toBe(problems[1]!.fingerprint);
    expect(fingerprintScope(after!.fingerprint)).toEqual({ kubeConfig: "/kube/config", context: "prod", namespace: "shop" });
    expect(fingerprintOf({ ...after!, kind: "image-pull" })).not.toBe(after!.fingerprint);
  });

  test("the first sighting stands in for a start time the cluster doesn't give", () => {
    const pull = rsPod("api-7d9f8-a", "api", [running("app", { ready: false, state: { waiting: { reason: "ErrImagePull" } } })]);
    pull.status.conditions[1]!.status = "True";
    const [problem] = detectProblems({ ...empty, pods: [pull], deployments: [deployment("api")] }, NOW, () => NOW - 5000);
    expect(problem!.firstSeen).toBe(NOW - 5000);
  });

  test("evicted pods count on their own", () => {
    const evicted = (name: string) => ({
      ...rsPod(name, "api", []),
      status: { phase: "Failed", reason: "Evicted", message: "The node was low on resource: memory." },
    });
    const [problem] = detectProblems({ ...empty, pods: [evicted("api-7d9f8-a"), evicted("api-7d9f8-b"), rsPod("api-7d9f8-c", "api", [running()])], deployments: [deployment("api")] }, NOW);
    expect(problem).toMatchObject({ kind: "evicted", pods: { affected: 2, total: 2 } });
    expect(podsWords(problem!)).toBe("2 pods");
  });

  test("thousands of pods stay fast", () => {
    const pods = Array.from({ length: 5000 }, (_, i) =>
      rsPod(`app-${i % 200}-7d9f8-${i}`, `app-${i % 200}`, [i % 50 === 0 ? crashing() : running()])
    );
    const deployments = Array.from({ length: 200 }, (_, i) => deployment(`app-${i}`));
    const started = performance.now();
    const problems = detectProblems({ ...empty, pods, deployments }, NOW);
    expect(performance.now() - started).toBeLessThan(150);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("managed by", () => {
  test("Argo CD, Flux and Helm, from their labels and annotations", () => {
    expect(managerOf({ metadata: { annotations: { "argocd.argoproj.io/tracking-id": "shop:apps/Deployment:shop/api" } } })).toEqual({ tool: "argocd", name: "shop" });
    expect(managerOf({ metadata: { annotations: { "argocd.argoproj.io/tracking-id": "argocd_shop:apps/Deployment:shop/api" } } })).toEqual({
      tool: "argocd",
      name: "shop",
      namespace: "argocd",
    });
    expect(managerOf({ metadata: { labels: { "argocd.argoproj.io/instance": "shop" } } })?.tool).toBe("argocd");
    expect(
      managerOf({ metadata: { labels: { "helm.toolkit.fluxcd.io/name": "api", "helm.toolkit.fluxcd.io/namespace": "flux-system" }, annotations: { "meta.helm.sh/release-name": "api" } } })
    ).toEqual({ tool: "flux", kind: "HelmRelease", name: "api", namespace: "flux-system" });
    expect(managerOf({ metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "apps" } } })).toMatchObject({ tool: "flux", kind: "Kustomization" });
    expect(managerOf({ metadata: { annotations: { "meta.helm.sh/release-name": "api", "meta.helm.sh/release-namespace": "shop" } } })).toEqual({
      tool: "helm",
      name: "api",
      namespace: "shop",
    });
    // A chart's own instance label isn't Argo CD.
    expect(managerOf({ metadata: { labels: { "app.kubernetes.io/instance": "api" } } })).toBeNull();
  });

  test("in words", () => {
    expect(managedWords({ tool: "argocd", name: "shop" })).toEqual({
      title: "Managed by Argo CD app shop",
      detail: "A change here is reverted on the next sync. Fix it in Git.",
    });
    expect(managedWords({ tool: "helm", name: "api" }).title).toBe("Managed by Helm release api");
  });
});

describe("snoozes", () => {
  const problem = (fingerprint: string) => ({ fingerprint }) as any;

  test("snoozed for a while, or acknowledged until resolved", () => {
    let snoozes = snooze([], "a", NOW, 3600_000);
    snoozes = snooze(snoozes, "b", NOW);
    expect(snoozes).toEqual([
      { fingerprint: "a", at: NOW, until: NOW + 3600_000 },
      { fingerprint: "b", at: NOW },
    ]);
    const { open, snoozed } = partition([problem("a"), problem("b"), problem("c")], snoozes, NOW);
    expect(open.map((p) => p.fingerprint)).toEqual(["c"]);
    expect(snoozed.map((s) => s.problem.fingerprint)).toEqual(["a", "b"]);
    expect(partition([problem("a")], snoozes, NOW + 3600_001).open).toHaveLength(1);
    expect(isActive(snoozes[1]!, NOW + 1e12)).toBe(true);
    expect(unsnooze(snoozes, "a").map((s) => s.fingerprint)).toEqual(["b"]);
    expect(snooze(snoozes, "a", NOW + 5, 60_000).filter((s) => s.fingerprint === "a")).toEqual([{ fingerprint: "a", at: NOW + 5, until: NOW + 60_005 }]);
  });

  test("pruning: expired snoozes, and acknowledgements of resolved problems where they'd show", () => {
    const snoozes = [
      { fingerprint: "expired", at: NOW, until: NOW - 1 },
      { fingerprint: "later", at: NOW, until: NOW + 60_000 },
      { fingerprint: "resolved", at: NOW },
      { fingerprint: "elsewhere", at: NOW },
      { fingerprint: "ongoing", at: NOW },
    ];
    const kept = prune(snoozes, new Set(["ongoing"]), (fp) => fp !== "elsewhere", NOW);
    expect(kept.map((s) => s.fingerprint)).toEqual(["later", "elsewhere", "ongoing"]);
    const unchanged = kept;
    expect(prune(unchanged, new Set(["ongoing"]), (fp) => fp !== "elsewhere", NOW)).toBe(unchanged);
  });
});

describe("fixes", () => {
  const problemOf = (pods: any[], deployments: any[] = [deployment("api")]) => detectProblems({ ...empty, pods, deployments }, NOW)[0]!;

  test("what each problem offers", () => {
    expect(fixesFor(problemOf([rsPod("api-7d9f8-a", "api", [crashing(137, "OOMKilled")])]))).toEqual(["raise-memory", "rollback", "restart"]);
    expect(fixesFor(problemOf([rsPod("api-7d9f8-a", "api", [crashing()])]))).toEqual(["rollback", "restart"]);
    const pull = running("app", { ready: false, state: { waiting: { reason: "ImagePullBackOff" } } });
    expect(fixesFor(problemOf([rsPod("api-7d9f8-a", "api", [pull])]))).toEqual(["rollback"]);
    // A bare pod can't be rolled back or given more memory.
    expect(fixesFor(problemOf([pod("lonely", [crashing(137, "OOMKilled")])], []))).toEqual([]);
    const stuck = pod("b", [running()], { metadata: { deletionTimestamp: ago(600) } });
    expect(fixesFor(problemOf([stuck], []))).toEqual(["delete-pod"]);
  });

  test("raising a memory limit", () => {
    expect(suggestMemoryLimit("256Mi")).toBe("384Mi");
    expect(suggestMemoryLimit("512Mi")).toBe("768Mi");
    expect(suggestMemoryLimit("1Gi")).toBe("1536Mi");
    expect(suggestMemoryLimit("4Gi")).toBe("6Gi");
    expect(suggestMemoryLimit("100M")).toBe("192Mi");
    expect(validMemory("768Mi")).toBe(true);
    expect(validMemory("1.5Gi")).toBe(true);
    expect(validMemory("lots")).toBe(false);
    expect(validMemory("0")).toBe(false);

    const problem = problemOf([rsPod("api-7d9f8-a", "api", [crashing(137, "OOMKilled")])]);
    const target = memoryTarget(problem)!;
    expect(target).toEqual({ container: "app", init: false });
    expect(memoryPatch("Deployment", target, "768Mi")).toEqual({
      spec: { template: { spec: { containers: [{ name: "app", resources: { limits: { memory: "768Mi" } } }] } } },
    });
    expect(memoryPatch("CronJob", { container: "migrate", init: true }, "1Gi")).toEqual({
      spec: { jobTemplate: { spec: { template: { spec: { initContainers: [{ name: "migrate", resources: { limits: { memory: "1Gi" } } }] } } } } },
    });
    const workload = { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "app", resources: { limits: { memory: "512Mi" } } }] } } } };
    expect(memoryLimitOf(workload, target)).toBe("512Mi");
  });

  test("the patch a rollback amounts to: only what differs", () => {
    const current = { spec: { containers: [{ name: "app", image: "api:1.5.0", env: [{ name: "A", value: "1" }] }, { name: "proxy", image: "envoy:1" }], serviceAccountName: "api" } };
    const previous = { spec: { containers: [{ name: "app", image: "api:1.4.2", env: [{ name: "A", value: "1" }] }, { name: "proxy", image: "envoy:1" }], serviceAccountName: "api" } };
    expect(revertPatch("Deployment", current, previous)).toEqual({ spec: { template: { spec: { containers: [{ name: "app", image: "api:1.4.2" }] } } } });
    expect(revertPatch("Deployment", current, current)).toBeNull();
    const volumes = { spec: { ...previous.spec, volumes: [{ name: "x" }] } };
    expect(revertPatch("StatefulSet", previous, volumes)).toEqual({ spec: { template: { spec: { volumes: [{ name: "x" }] } } } });
  });

  test("retrying a Job: a copy without the controller's selector and labels", () => {
    const job = {
      metadata: { name: "migrate-2026", namespace: "shop", uid: "x", labels: { app: "migrate", "job-name": "migrate-2026" } },
      spec: {
        backoffLimit: 2,
        selector: { matchLabels: { "controller-uid": "x" } },
        template: { metadata: { labels: { app: "migrate", "controller-uid": "x", "batch.kubernetes.io/job-name": "migrate-2026" } }, spec: { containers: [] } },
      },
      status: { failed: 3 },
    };
    expect(retryJob(job)).toEqual({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { generateName: "migrate-2026-retry-", namespace: "shop", labels: { app: "migrate" } },
      spec: { backoffLimit: 2, template: { metadata: { labels: { app: "migrate" } }, spec: { containers: [] } } },
    });
  });
});
