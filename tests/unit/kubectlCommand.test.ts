import { describe, expect, test } from "vitest";
import {
  annotateArgs,
  changesCluster,
  clusterFlags,
  commandFromArgv,
  commandLine,
  deletePodArgs,
  execArgs,
  kindRef,
  kubectlFor,
  localPortFor,
  logsArgs,
  manualJobName,
  mergePatchArgs,
  portForwardArgs,
  scaleArgs,
  selectorLogsArgs,
  shellQuote,
  triggerCronJobArgs,
  type KubectlDefaults,
} from "../../src/lib/kubectl/command";
import { rolloutArgs } from "../../src/lib/rollout";
import { clusterArgs, helmClusterArgs } from "../../src/lib/workloads";

const HOME_CONFIG = "/home/me/.kube/config";

/* ~/.kube/config with prod (current, namespace "payments") and staging. */
const defaults = (overrides: Partial<KubectlDefaults> = {}): KubectlDefaults => ({
  kubeconfigs: [HOME_CONFIG],
  currentContext: (kubeConfig) => (kubeConfig ? "kind-dev" : "prod"),
  namespaceOf: (context) => (context === "prod" ? "payments" : null),
  ...overrides,
});

describe("shell quoting", () => {
  test("safe words stay bare", () => {
    for (const word of ["deployment/web", "--replicas=3", "app=web,tier=api", "8080:80", "user@host", "a.b-c_d"]) {
      expect(shellQuote(word)).toBe(word);
    }
  });

  test("everything else is single-quoted", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote('{"spec":{"suspend":true}}')).toBe(`'{"spec":{"suspend":true}}'`);
    expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("~/config")).toBe("'~/config'");
    expect(shellQuote("a*")).toBe("'a*'");
    expect(shellQuote("!x")).toBe("'!x'");
    // zsh expands `=word` to a path.
    expect(shellQuote("=ls")).toBe("'=ls'");
  });
});

describe("cluster flags", () => {
  test("none for the current context in its own namespace", () => {
    expect(clusterFlags("kubectl", { context: "prod", namespace: "payments" }, defaults())).toEqual([]);
    expect(
      clusterFlags("kubectl", { context: "prod", kubeConfig: HOME_CONFIG, namespace: "payments" }, defaults())
    ).toEqual([]);
  });

  test("-n when the namespace isn't the context's", () => {
    expect(clusterFlags("kubectl", { context: "prod", namespace: "web" }, defaults())).toEqual(["-n", "web"]);
    // Contexts without a namespace use "default".
    expect(clusterFlags("kubectl", { context: "staging", namespace: "default" }, defaults())).toEqual([
      "--context",
      "staging",
    ]);
  });

  test("no -n for cluster-scoped objects", () => {
    expect(clusterFlags("kubectl", { context: "prod" }, defaults())).toEqual([]);
  });

  test("--context when it isn't the current one", () => {
    expect(clusterFlags("kubectl", { context: "staging", namespace: "web" }, defaults())).toEqual([
      "-n",
      "web",
      "--context",
      "staging",
    ]);
  });

  test("--kubeconfig for other files, whose own current context counts", () => {
    const kind = "/home/me/.kube/config.d/kind.yaml";
    expect(clusterFlags("kubectl", { context: "kind-dev", kubeConfig: kind }, defaults())).toEqual([
      "--kubeconfig",
      kind,
    ]);
    expect(clusterFlags("kubectl", { context: "other", kubeConfig: kind }, defaults())).toEqual([
      "--context",
      "other",
      "--kubeconfig",
      kind,
    ]);
  });

  test("paths compare normalized", () => {
    expect(clusterFlags("kubectl", { context: "prod", kubeConfig: `${HOME_CONFIG}/` }, defaults())).toEqual([]);
  });

  test("no known current context: --context is spelled out", () => {
    const unknown = defaults({ currentContext: () => null });
    expect(clusterFlags("kubectl", { context: "prod" }, unknown)).toEqual(["--context", "prod"]);
  });

  test("helm says --kube-context", () => {
    expect(clusterFlags("helm", { context: "staging", namespace: "web" }, defaults())).toEqual([
      "-n",
      "web",
      "--kube-context",
      "staging",
    ]);
  });
});

describe("commands from the argv the app runs", () => {
  test("cluster flags become the target, in either form", () => {
    const argv = [
      ...rolloutArgs("restart", "Deployment", "web"),
      ...clusterArgs({ context: "staging", namespace: "web", kubeConfig: HOME_CONFIG }),
    ];
    expect(commandFromArgv("kubectl", argv)).toEqual({
      program: "kubectl",
      args: ["rollout", "restart", "deployment/web"],
      target: { context: "staging", namespace: "web", kubeConfig: HOME_CONFIG },
    });
    expect(
      commandFromArgv("kubectl", ["drain", "node-1", "--force", "--context", "prod", "--kubeconfig", HOME_CONFIG]).target
    ).toEqual({ context: "prod", kubeConfig: HOME_CONFIG });
  });

  test("helm's --kube-context, and app-only flags dropped", () => {
    const spec = commandFromArgv("helm", [
      "rollback",
      "api",
      "3",
      ...helmClusterArgs({ context: "prod", namespace: "shop" }),
      "--request-timeout=30s",
    ]);
    expect(spec).toEqual({ program: "helm", args: ["rollback", "api", "3"], target: { context: "prod", namespace: "shop" } });
    expect(commandFromArgv("kubectl", ["get", "pods", "--request-timeout", "30s"]).args).toEqual(["get", "pods"]);
  });

  test("the command run in a container is left alone", () => {
    const spec = commandFromArgv("kubectl", ["exec", "-it", "web", "--context", "prod", "--", "sh", "-n", "x"]);
    expect(spec.args).toEqual(["exec", "-it", "web", "--", "sh", "-n", "x"]);
  });
});

describe("command lines", () => {
  test("a change always names its cluster, even the current one", () => {
    const spec = kubectlFor(
      { metadata: { context: "prod", kubeConfig: HOME_CONFIG, namespace: "payments" } },
      rolloutArgs("restart", "Deployment", "payments-api")
    );
    expect(commandLine(spec, defaults())).toBe("kubectl rollout restart deployment/payments-api -n payments --context prod");
  });

  test("a read on the current cluster is just the verb", () => {
    const target = { metadata: { context: "prod", kubeConfig: HOME_CONFIG, namespace: "payments" } };
    expect(commandLine(kubectlFor(target, ["rollout", "history", "deployment/payments-api"]), defaults())).toBe(
      "kubectl rollout history deployment/payments-api"
    );
    expect(commandLine(kubectlFor(target, ["logs", "pod/web-1"]), defaults())).toBe("kubectl logs pod/web-1");
    expect(changesCluster({ program: "helm", args: ["history", "api"] })).toBe(false);
    expect(changesCluster({ program: "helm", args: ["rollback", "api", "3"] })).toBe(true);
  });

  test("elsewhere it says where", () => {
    const spec = kubectlFor({ metadata: { context: "staging eu", namespace: "web" } }, scaleArgs("deployment/web", 3));
    expect(commandLine(spec, defaults())).toBe("kubectl scale deployment/web --replicas=3 -n web --context 'staging eu'");
  });

  test("cluster flags go before the container's command", () => {
    const spec = kubectlFor({ metadata: { context: "staging", namespace: "web" } }, execArgs("web-1", "app", "/bin/sh"));
    expect(commandLine(spec, defaults())).toBe("kubectl exec -it web-1 -c app -n web --context staging -- /bin/sh");
  });

  test("patches and annotations are quoted", () => {
    const ref = kindRef({ kind: "Kustomization", apiVersion: "kustomize.toolkit.fluxcd.io/v1", metadata: { name: "apps" } });
    const patch = kubectlFor({ metadata: { context: "prod", namespace: "flux-system" } }, mergePatchArgs(ref, { spec: { suspend: true } }));
    expect(commandLine(patch, defaults())).toBe(
      `kubectl patch kustomization.kustomize.toolkit.fluxcd.io/apps --type=merge -p '{"spec":{"suspend":true}}' -n flux-system --context prod`
    );
    const annotate = annotateArgs("scaledobject.keda.sh/api", {
      "autoscaling.keda.sh/paused": null,
      "autoscaling.keda.sh/paused-replicas": null,
      skipped: undefined,
    });
    expect(annotate).toEqual([
      "annotate",
      "scaledobject.keda.sh/api",
      "autoscaling.keda.sh/paused-",
      "autoscaling.keda.sh/paused-replicas-",
      "--overwrite",
    ]);
  });
});

describe("action arguments", () => {
  test("references qualify add-on kinds only", () => {
    expect(kindRef({ kind: "Deployment", apiVersion: "apps/v1", metadata: { name: "web" } })).toBe("deployment/web");
    expect(kindRef({ kind: "Pod", apiVersion: "v1", metadata: { name: "web-1" } })).toBe("pod/web-1");
    expect(kindRef({ kind: "Ingress", apiVersion: "networking.k8s.io/v1", metadata: { name: "x" } })).toBe("ingress/x");
    expect(kindRef({ kind: "Certificate", apiVersion: "cert-manager.io/v1", metadata: { name: "tls" } })).toBe(
      "certificate.cert-manager.io/tls"
    );
  });

  test("logs, exec and port-forward", () => {
    expect(logsArgs("web-1")).toEqual(["logs", "web-1", "--all-containers", "-f"]);
    expect(logsArgs("web-1", { container: "app", previous: true })).toEqual(["logs", "web-1", "-c", "app", "--previous"]);
    expect(selectorLogsArgs("app=web")).toEqual(["logs", "-l", "app=web", "--all-containers", "--prefix", "-f"]);
    expect(execArgs("web-1", "app", "/bin/bash")).toEqual(["exec", "-it", "web-1", "-c", "app", "--", "/bin/bash"]);
    expect(portForwardArgs("service/web", [{ local: localPortFor(80), remote: 80 }, { local: 9090, remote: 9090 }])).toEqual([
      "port-forward",
      "service/web",
      "8080:80",
      "9090",
    ]);
  });

  test("delete, and the cron job's manual run", () => {
    expect(deletePodArgs("web-1", true)).toEqual(["delete", "pod", "web-1", "--grace-period=0", "--force"]);
    expect(deletePodArgs("web-1", false)).toEqual(["delete", "pod", "web-1"]);
    expect(manualJobName("nightly", 36 ** 5 + 42)).toBe("nightly-manual-00016");
    expect(triggerCronJobArgs("nightly", "nightly-manual-abcde")).toEqual([
      "create",
      "job",
      "--from=cronjob/nightly",
      "nightly-manual-abcde",
    ]);
  });
});
