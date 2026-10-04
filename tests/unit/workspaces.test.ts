import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  describeWorkspace,
  moveWorkspace,
  nextWorkspaceName,
  parseWorkspaces,
  updateWorkspace,
  type WorkspaceState,
} from "@/lib/workspaces";

const state: WorkspaceState = {
  contexts: [
    { context: "prod", kubeConfig: "/k", namespaces: ["payments", "checkout"] },
    { context: "staging", kubeConfig: "/k", namespaces: ["all"] },
  ],
  tabs: {
    tabs: [
      {
        id: "describe_prod_payments_Pod_api",
        title: "api",
        icon: "describe",
        type: "describe",
        props: { context: "prod", namespace: "payments", kubeConfig: "/k", type: "Pod", name: "api" },
      },
    ],
    activeTabId: "describe_prod_payments_Pod_api",
  },
  portForwardProfileIds: ["/k|prod|payments|service/api:80|127.0.0.1:8080"],
  route: "/deployments?resource=deployments&kind=Deployment",
};

describe("workspaces", () => {
  it("snapshots the state (detached from the live objects)", () => {
    const workspace = createWorkspace("  Payments  ", state, 100, "ws-1");
    expect(workspace).toMatchObject({ id: "ws-1", name: "Payments", updatedAt: 100 });
    expect(workspace.contexts).toEqual(state.contexts);
    expect(workspace.contexts).not.toBe(state.contexts);
    state.contexts[0].namespaces.push("mutated");
    expect(workspace.contexts[0].namespaces).toEqual(["payments", "checkout"]);
    state.contexts[0].namespaces.pop();
  });

  it("updates the state but keeps id and name", () => {
    const workspace = createWorkspace("A", state, 1, "ws-1");
    const updated = updateWorkspace(
      workspace,
      { ...state, contexts: [], route: "/pods" },
      2
    );
    expect(updated).toMatchObject({ id: "ws-1", name: "A", route: "/pods", updatedAt: 2 });
    expect(updated.contexts).toEqual([]);
  });

  it("names new workspaces after the first free number", () => {
    expect(nextWorkspaceName([])).toBe("Workspace 1");
    expect(nextWorkspaceName([{ name: "Workspace 1" }, { name: "workspace 3" }])).toBe(
      "Workspace 2"
    );
  });

  it("describes a workspace", () => {
    expect(describeWorkspace(state)).toBe("prod, staging · 1 tab · 1 forward");
    expect(
      describeWorkspace({
        ...state,
        contexts: ["a", "b", "c", "d"].map((context) => ({ context, kubeConfig: "", namespaces: ["all"] })),
        tabs: { tabs: [], activeTabId: null },
        portForwardProfileIds: [],
      })
    ).toBe("a, b +2");
  });

  it("round-trips through JSON and drops invalid entries", () => {
    const a = createWorkspace("A", state, 1, "ws-a");
    const parsed = parseWorkspaces([
      JSON.parse(JSON.stringify(a)),
      { ...a, name: "duplicate id" },
      { id: "ws-b", name: "B", contexts: [{ context: "", kubeConfig: "", namespaces: [] }, { context: "x", kubeConfig: "/k", namespaces: ["all"] }], tabs: "nope" },
      { name: "no id" },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(a);
    expect(parsed[1]).toMatchObject({
      id: "ws-b",
      contexts: [{ context: "x", kubeConfig: "/k", namespaces: ["all"] }],
      tabs: { tabs: [], activeTabId: null },
      portForwardProfileIds: [],
      route: null,
    });
    expect(parseWorkspaces(null)).toEqual([]);
  });

  it("reorders workspaces for the hotbar", () => {
    const list = ["a", "b", "c"].map((id) => createWorkspace(id, state, 0, id));
    expect(moveWorkspace(list, "c", 0).map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(moveWorkspace(list, "a", 9).map((w) => w.id)).toEqual(["b", "c", "a"]);
    expect(moveWorkspace(list, "zz", 0)).toBe(list);
  });
});
