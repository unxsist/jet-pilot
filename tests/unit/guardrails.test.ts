import { afterEach, describe, expect, test } from "vitest";
import {
  actionKindForLabel,
  changesCluster,
  confirmPhrase,
  decide,
  decideMany,
  effectOf,
  phraseMatches,
  pluralKind,
  scaleKind,
  verbOf,
  type ActionKind,
  type GuardedCluster,
} from "@/lib/guardrails/policy";
import {
  assertWritable,
  cliMutationTarget,
  cliRefusal,
  guardedCluster,
  ReadOnlyClusterError,
} from "@/lib/guardrails/backstop";
import { blockedReason, rowActionKind, rowClusterRef } from "@/lib/guardrails/menu";
import { setRuntimeSettings } from "@/lib/settings/runtime";
import type { ClusterRecord } from "@/lib/clusters/meta";
import type { Settings } from "@/lib/settings/types";
import type { RowAction } from "@/components/tables/types";

const plain: GuardedCluster = { protected: false, readOnly: false, displayName: "dev-1" };
const prod: GuardedCluster = { protected: true, readOnly: false, displayName: "prod-eu" };
const locked: GuardedCluster = { protected: false, readOnly: true, displayName: "audit" };
const lockedProd: GuardedCluster = { protected: true, readOnly: true, displayName: "prod-us" };

const ALL: ActionKind[] = [
  "delete",
  "drain",
  "cordon",
  "uncordon",
  "scale",
  "scale-to-zero",
  "restart",
  "pause",
  "resume",
  "rollback",
  "apply",
  "create",
  "replace",
  "edit-secret",
  "helm-upgrade",
  "helm-rollback",
  "helm-uninstall",
  "cronjob-trigger",
  "copy-to-pod",
  "debug",
  "node-shell",
  "exec",
  "port-forward",
  "logs",
  "describe",
  "view",
];

describe("effectOf", () => {
  test("classifies every action", () => {
    for (const kind of ALL) {
      expect(["read", "interactive", "mutate", "destructive"]).toContain(effectOf(kind));
    }
  });

  test("destructive and read actions", () => {
    expect(effectOf("delete")).toBe("destructive");
    expect(effectOf("drain")).toBe("destructive");
    expect(effectOf("scale-to-zero")).toBe("destructive");
    expect(effectOf("helm-uninstall")).toBe("destructive");
    expect(effectOf("scale")).toBe("mutate");
    expect(effectOf("exec")).toBe("interactive");
    expect(effectOf("port-forward")).toBe("interactive");
    expect(effectOf("logs")).toBe("read");
    expect(changesCluster("debug")).toBe(true);
    expect(changesCluster("describe")).toBe(false);
  });
});

describe("decide", () => {
  test("read-only clusters block every change, nothing else", () => {
    for (const kind of ALL) {
      const decision = decide(kind, locked);
      expect(decision.allowed).toBe(!changesCluster(kind));
      if (!decision.allowed) {
        expect(decision.reason).toBe("audit is read-only in JET Pilot");
        expect(decision.confirm).toBe("none");
      }
    }
    // Viewing, logs, port forwards, shells: still allowed.
    for (const kind of ["view", "describe", "logs", "port-forward", "exec"] as const) {
      expect(decide(kind, locked).allowed).toBe(true);
    }
  });

  test("read-only wins over protected", () => {
    expect(decide("delete", lockedProd).allowed).toBe(false);
    expect(decide("logs", lockedProd)).toMatchObject({ allowed: true, confirm: "none" });
  });

  test("protected clusters: typed confirmation for the risky actions", () => {
    const typed: ActionKind[] = [
      "delete",
      "drain",
      "scale-to-zero",
      "helm-upgrade",
      "helm-rollback",
      "helm-uninstall",
      "apply",
      "create",
      "replace",
      "edit-secret",
    ];
    for (const kind of ALL) {
      expect(decide(kind, prod, { resourceName: "web" }).confirm === "typed").toBe(
        typed.includes(kind)
      );
    }
    expect(decide("delete", prod, { resourceName: "web-7f9" })).toEqual({
      allowed: true,
      confirm: "typed",
      phrase: "web-7f9",
      requireDryRun: false,
    });
  });

  test("protected clusters: applying YAML requires the dry run", () => {
    for (const kind of ["apply", "create", "replace", "edit-secret"] as const) {
      expect(decide(kind, prod).requireDryRun).toBe(true);
      expect(decide(kind, plain).requireDryRun).toBe(false);
    }
    expect(decide("helm-upgrade", prod).requireDryRun).toBe(false);
  });

  test("other clusters keep the app's own confirmations", () => {
    expect(decide("delete", plain)).toEqual({
      allowed: true,
      confirm: "simple",
      requireDryRun: false,
    });
    expect(decide("scale", prod).confirm).toBe("simple");
    expect(decide("restart", prod).confirm).toBe("simple");
    expect(decide("logs", plain).confirm).toBe("none");
    expect(decide("replace", plain).confirm).toBe("none");
  });

  test("scaling to zero escalates on protected clusters", () => {
    expect(scaleKind(3)).toBe("scale");
    expect(scaleKind(0)).toBe("scale-to-zero");
    expect(decide(scaleKind(2), prod).confirm).toBe("simple");
    expect(decide(scaleKind(0), prod, { resourceName: "api" })).toMatchObject({
      confirm: "typed",
      phrase: "api",
    });
    expect(decide(scaleKind(0), plain).confirm).toBe("simple");
    expect(decide(scaleKind(0), locked).allowed).toBe(false);
  });
});

describe("confirmation phrase", () => {
  test("the name of one target, a count for several", () => {
    expect(confirmPhrase(prod, { resourceName: "nginx-abc" })).toBe("nginx-abc");
    expect(confirmPhrase(prod, { count: 3, resourceKind: "Pod" })).toBe("3 pods");
    expect(confirmPhrase(prod, { count: 2, resourceKind: "Ingress" })).toBe("2 ingresses");
    expect(confirmPhrase(prod, { count: 4 })).toBe("4 resources");
    expect(decide("delete", prod, { count: 3, resourceKind: "Pod", resourceName: "a" }).phrase).toBe(
      "3 pods"
    );
  });

  test("falls back to the cluster name", () => {
    expect(confirmPhrase(prod)).toBe("prod-eu");
    expect(confirmPhrase(prod, { count: 1, resourceName: "  " })).toBe("prod-eu");
  });

  test("plurals", () => {
    expect(pluralKind("Deployment")).toBe("deployments");
    expect(pluralKind("NetworkPolicy")).toBe("networkpolicies");
    expect(pluralKind("release")).toBe("releases");
    expect(pluralKind("")).toBe("resources");
  });

  test("matching ignores surrounding and repeated whitespace only", () => {
    expect(phraseMatches(" 3  pods ", "3 pods")).toBe(true);
    expect(phraseMatches("3 Pods", "3 pods")).toBe(false);
    expect(phraseMatches("nginx", "nginx-abc")).toBe(false);
    expect(phraseMatches("", "x")).toBe(false);
  });
});

describe("decideMany", () => {
  test("a read-only cluster blocks the whole action", () => {
    expect(decideMany("delete", [plain, locked], { count: 2 })).toMatchObject({
      allowed: false,
      reason: "audit is read-only in JET Pilot",
    });
  });

  test("a protected cluster asks for the typed count of all targets", () => {
    expect(
      decideMany("delete", [plain, prod], { count: 5, resourceKind: "Pod" })
    ).toMatchObject({ allowed: true, confirm: "typed", phrase: "5 pods" });
    expect(decideMany("restart", [plain, prod], { count: 2 }).confirm).toBe("simple");
    expect(decideMany("delete", [], {}).allowed).toBe(true);
  });
});

describe("labels", () => {
  test("row action labels map to kinds", () => {
    expect(actionKindForLabel("Delete")).toBe("delete");
    expect(actionKindForLabel("Kill")).toBe("delete");
    expect(actionKindForLabel("Uninstall")).toBe("helm-uninstall");
    expect(actionKindForLabel("Uncordon")).toBe("uncordon");
    expect(actionKindForLabel(" Pause rollout ")).toBe("pause");
    expect(actionKindForLabel("Shell")).toBe("exec");
    // Opening the editor / the copy dialog stays allowed: they guard inside.
    expect(actionKindForLabel("Edit YAML")).toBeUndefined();
    expect(actionKindForLabel("Copy files")).toBeUndefined();
  });

  test("verbs", () => {
    expect(verbOf("delete")).toBe("Delete");
    expect(verbOf("scale-to-zero")).toBe("Scale to 0");
    expect(verbOf("helm-uninstall")).toBe("Uninstall");
  });
});

/* ---------------------------------------------------------- backstop -- */

const records: ClusterRecord[] = [
  { kubeConfig: "/k/prod.yaml", context: "prod", readOnly: true },
  { kubeConfig: "", context: "shared", protected: true },
  { kubeConfig: "/k/a.yaml", context: "dev", env: "dev" },
];

const useRecords = (clusters: ClusterRecord[]) =>
  setRuntimeSettings(() => ({ clusters }) as unknown as Settings);

afterEach(() => setRuntimeSettings(null));

describe("cliMutationTarget", () => {
  test("kubectl verbs that change the cluster", () => {
    expect(cliMutationTarget("kubectl", ["delete", "pod/x", "--context", "prod"])).toEqual({
      context: "prod",
      kubeConfig: undefined,
    });
    expect(
      cliMutationTarget("kubectl", [
        "scale",
        "--replicas=0",
        "deployment/x",
        "--context=prod",
        "--kubeconfig=/k/prod.yaml",
      ])
    ).toEqual({ context: "prod", kubeConfig: "/k/prod.yaml" });
    expect(cliMutationTarget("kubectl", ["rollout", "restart", "deploy/x", "--context", "c"])).not.toBeNull();
    expect(cliMutationTarget("kubectl", ["drain", "n1", "--force", "--context", "c"])).not.toBeNull();
  });

  test("reads, dry runs and the current context are not checked", () => {
    expect(cliMutationTarget("kubectl", ["get", "pods", "--context", "prod"])).toBeNull();
    expect(cliMutationTarget("kubectl", ["rollout", "history", "deploy/x", "--context", "c"])).toBeNull();
    expect(cliMutationTarget("kubectl", ["logs", "pod", "--context", "c"])).toBeNull();
    expect(
      cliMutationTarget("kubectl", ["apply", "-f", "-", "--dry-run=server", "--context", "c"])
    ).toBeNull();
    expect(cliMutationTarget("kubectl", ["delete", "pod/x"])).toBeNull();
  });

  test("kubectl cp: uploads only", () => {
    const remote = "ns/pod:/tmp/file";
    expect(cliMutationTarget("kubectl", ["cp", "/local/file", remote, "--context", "c"])).not.toBeNull();
    expect(cliMutationTarget("kubectl", ["cp", remote, "/local/file", "--context", "c"])).toBeNull();
    expect(cliMutationTarget("kubectl", ["cp", remote, "C:\\Users\\me\\f", "--context", "c"])).toBeNull();
  });

  test("helm", () => {
    expect(
      cliMutationTarget("helm", ["uninstall", "web", "--kube-context", "prod", "--namespace", "a"])
    ).toEqual({ context: "prod", kubeConfig: undefined });
    expect(cliMutationTarget("helm", ["upgrade", "web", "repo/web", "--kube-context=c"])).not.toBeNull();
    expect(cliMutationTarget("helm", ["diff", "upgrade", "web", "--kube-context", "c"])).toBeNull();
    expect(cliMutationTarget("helm", ["template", "web", "--kube-context", "c"])).toBeNull();
    expect(cliMutationTarget("helm", ["history", "web", "--kube-context", "c"])).toBeNull();
  });
});

describe("backstop", () => {
  test("refuses changes to read-only clusters unless guarded", () => {
    useRecords(records);
    const args = ["delete", "pod/x", "--context", "prod", "--kubeconfig", "/k/prod.yaml"];
    expect(cliRefusal("kubectl", args)).toMatch(/^prod is read-only in JET Pilot/);
    expect(cliRefusal("kubectl", args, { guarded: true })).toBeNull();
    expect(cliRefusal("kubectl", ["get", "pods", "--context", "prod"])).toBeNull();
    // Another kubeconfig's "prod" is a different cluster.
    expect(
      cliRefusal("kubectl", ["delete", "pod/x", "--context", "prod", "--kubeconfig", "/k/other.yaml"])
    ).toBeNull();
  });

  test("without a kubeconfig any record of the context name applies", () => {
    useRecords(records);
    expect(guardedCluster("prod").readOnly).toBe(true);
    expect(guardedCluster("prod", "").readOnly).toBe(true);
    expect(guardedCluster("shared", "/k/any.yaml").protected).toBe(true);
    expect(guardedCluster("dev", "/k/a.yaml").protected).toBe(false);
  });

  test("assertWritable", () => {
    useRecords(records);
    expect(() => assertWritable("prod", "/k/prod.yaml")).toThrow(ReadOnlyClusterError);
    expect(() => assertWritable("prod", "/k/prod.yaml", { guarded: true })).not.toThrow();
    expect(() => assertWritable("dev", "/k/a.yaml")).not.toThrow();
  });

  test("no settings loaded: nothing is read-only", () => {
    expect(cliRefusal("kubectl", ["delete", "pod/x", "--context", "prod"])).toBeNull();
    expect(() => assertWritable("prod")).not.toThrow();
  });
});

/* -------------------------------------------------------------- menus -- */

type Row = { kind?: string; metadata: { name: string; context?: string; kubeConfig?: string } };

const row = (context: string, kubeConfig = "", name = "x"): Row => ({
  kind: "Pod",
  metadata: { name, context, kubeConfig },
});

const resolve = (ref: { context: string }): GuardedCluster =>
  ref.context === "audit" ? locked : ref.context === "prod-eu" ? prod : plain;

describe("menu helpers", () => {
  const del: RowAction<Row> = { label: "Delete", massAction: true, handler: () => {} };
  const logs: RowAction<Row> = { label: "Logs", handler: () => {} };
  const edit: RowAction<Row> = { label: "Edit YAML", handler: () => {} };
  const upgrade: RowAction<Row> = { label: "Upgrade", kind: "helm-upgrade", handler: () => {} };
  const cordon: RowAction<Row> = {
    label: (r: Row) => (r.metadata.name === "cordoned" ? "Uncordon" : "Cordon"),
    handler: () => {},
  };

  test("rows carry their cluster", () => {
    expect(rowClusterRef(row("c", "/k"))).toEqual({ context: "c", kubeConfig: "/k" });
    expect(rowClusterRef({ metadata: { name: "x" } })).toBeNull();
    expect(rowClusterRef(null)).toBeNull();
  });

  test("kind: explicit, else from the (row's) label", () => {
    expect(rowActionKind(upgrade, null)).toBe("helm-upgrade");
    expect(rowActionKind(del, null)).toBe("delete");
    expect(rowActionKind(cordon, row("c", "", "cordoned"))).toBe("uncordon");
    expect(rowActionKind(edit, null)).toBeUndefined();
  });

  test("blocked on read-only clusters only", () => {
    expect(blockedReason(del, [row("audit")], resolve)).toBe("audit is read-only in JET Pilot");
    expect(blockedReason(del, [row("prod-eu")], resolve)).toBeNull();
    expect(blockedReason(logs, [row("audit")], resolve)).toBeNull();
    expect(blockedReason(edit, [row("audit")], resolve)).toBeNull();
    expect(blockedReason(cordon, [row("audit")], resolve)).not.toBeNull();
  });

  test("a selection is blocked when any of its clusters is", () => {
    const rows = [row("dev-1"), row("prod-eu"), row("audit")];
    expect(blockedReason(del, rows, resolve)).toBe("audit is read-only in JET Pilot");
    expect(blockedReason(del, rows.slice(0, 2), resolve)).toBeNull();
    expect(blockedReason(del, [], resolve)).toBeNull();
  });

  test("resolves each cluster once", () => {
    let calls = 0;
    const counting = (ref: { context: string }) => {
      calls++;
      return resolve(ref);
    };
    blockedReason(del, Array.from({ length: 500 }, (_, i) => row("dev-1", "", `p${i}`)), counting);
    expect(calls).toBe(1);
  });
});
