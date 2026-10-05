import { describe, expect, it } from "vitest";
import {
  describeTab,
  describeTabs,
  inferTabType,
  isPtyTabType,
  parseTabSession,
} from "@/lib/tabDescriptors";

const target = { context: "prod", namespace: "payments", kubeConfig: "/k" };

describe("tab descriptors", () => {
  it("infers the tab type from icon and props", () => {
    expect(inferTabType({ id: "a", title: "", icon: "logs", props: { object: "p" } })).toBe("logs");
    expect(inferTabType({ id: "a", title: "", icon: "describe" })).toBe("describe");
    expect(inferTabType({ id: "a", title: "", icon: "edit", props: {} })).toBe("edit");
    expect(inferTabType({ id: "a", title: "", icon: "edit", props: { create: true } })).toBeNull();
    expect(inferTabType({ id: "a", title: "", icon: "shell", props: { pod: {} } })).toBe("shell");
    expect(inferTabType({ id: "a", title: "", icon: "shell", props: {} })).toBe("terminal");
    expect(inferTabType({ id: "a", title: "", icon: "tab" })).toBeNull();
  });

  it("keeps only whitelisted plain props", () => {
    const descriptor = describeTab({
      id: "logs_prod_payments_api",
      title: "api",
      icon: "logs",
      props: { ...target, object: "deployment/api", container: "app", row: { huge: true }, onDone: () => {} },
    });
    expect(descriptor).toEqual({
      id: "logs_prod_payments_api",
      title: "api",
      icon: "logs",
      type: "logs",
      props: { ...target, object: "deployment/api", container: "app" },
    });
  });

  it("slims the pod of a shell tab to what Shell.vue needs", () => {
    const descriptor = describeTab({
      id: "shell",
      title: "api",
      icon: "shell",
      props: {
        ...target,
        pod: {
          metadata: { name: "api-1", namespace: "payments", labels: { a: "b" } },
          spec: { containers: [{ name: "app", image: "x" }, { name: "sidecar" }] },
          status: { phase: "Running" },
        },
        container: { name: "app", image: "x" },
      },
    });
    expect(descriptor?.props).toEqual({
      ...target,
      pod: {
        metadata: { name: "api-1", namespace: "payments" },
        spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
      },
      container: { name: "app" },
    });
  });

  it("skips tabs that cannot be restored", () => {
    expect(describeTab({ id: "x", title: "", icon: "describe", props: { ...target } })).toBeNull();
    expect(describeTab({ id: "x", title: "", icon: "logs", props: { object: "p" } })).toBeNull();
    expect(describeTab({ id: "x", title: "", icon: "edit", props: { ...target, name: "a", create: true } })).toBeNull();
  });

  it("round-trips through JSON", () => {
    const session = describeTabs(
      [
        { id: "t1", title: "Terminal", icon: "shell", props: target },
        { id: "d1", title: "api", icon: "describe", props: { ...target, type: "Pod", name: "api" } },
        { id: "new", title: "New Pod", icon: "edit", props: { ...target, create: true } },
      ],
      "new"
    );
    expect(session.tabs.map((t) => t.id)).toEqual(["t1", "d1"]);
    // The active tab was not restorable: fall back to the last one.
    expect(session.activeTabId).toBe("d1");
    expect(parseTabSession(JSON.parse(JSON.stringify(session)))).toEqual(session);
  });

  it("drops invalid and duplicate stored entries", () => {
    const parsed = parseTabSession({
      tabs: [
        { id: "a", title: "a", icon: "logs", type: "logs", props: { context: "c" } },
        { id: "a", title: "dup", icon: "logs", type: "logs", props: { context: "c" } },
        { id: "b", title: "b", icon: "x", type: "unknown", props: { context: "c" } },
        { id: "c", title: "c", icon: "logs", type: "logs" },
        null,
      ],
      activeTabId: "zzz",
    });
    expect(parsed.tabs.map((t) => t.title)).toEqual(["a"]);
    expect(parsed.activeTabId).toBe("a");
    expect(parseTabSession(undefined)).toEqual({ tabs: [], activeTabId: null });
  });

  it("never persists kubectl debug sessions (node shells, ephemeral containers)", () => {
    const nodeShell = {
      id: "node-shell//default/Node/worker-1/1700000000000",
      title: "node/worker-1",
      icon: "shell",
      props: { ...target, argv: ["kubectl", "debug", "node/worker-1"], cleanupDebugPod: true, banner: "Root shell" },
    };
    const debug = {
      id: "debug/prod/payments/Pod/api-1/1700000000000",
      title: "pod/api-1 debug",
      icon: "debug",
      props: { ...target, argv: ["kubectl", "debug", "api-1"] },
    };
    expect(inferTabType(nodeShell)).toBeNull();
    expect(describeTab(nodeShell)).toBeNull();
    expect(describeTab(debug)).toBeNull();
    expect(describeTabs([nodeShell, debug], nodeShell.id)).toEqual({ tabs: [], activeTabId: null });
  });

  it("drops node shells stored as terminals by older versions", () => {
    const parsed = parseTabSession({
      tabs: [
        { id: "node-shell//default/Node/worker-1/17", title: "node/worker-1", icon: "shell", type: "terminal", props: { ...target } },
        { id: "terminal_prod_17", title: "Terminal: prod", icon: "shell", type: "terminal", props: { ...target } },
      ],
      activeTabId: "node-shell//default/Node/worker-1/17",
    });
    expect(parsed.tabs.map((t) => t.id)).toEqual(["terminal_prod_17"]);
    expect(parsed.activeTabId).toBe("terminal_prod_17");
  });

  it("marks shells and terminals as pty tabs (restored behind Reconnect)", () => {
    expect(isPtyTabType("shell")).toBe(true);
    expect(isPtyTabType("terminal")).toBe(true);
    expect(isPtyTabType("logs")).toBe(false);
    expect(isPtyTabType("describe")).toBe(false);
    expect(isPtyTabType("edit")).toBe(false);
  });
});
