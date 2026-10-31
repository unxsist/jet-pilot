import { describe, expect, it } from "vitest";
import { isPopOutLabel, type WindowRecord } from "@/lib/windows";
import {
  applyReport,
  newWindowLabel,
  windowTitle,
  parsePayload,
  parseTabTransfer,
  parseWindowRecords,
  storableRecords,
} from "@/lib/windowRecords";

const LOGS = {
  id: "logs_prod_checkout_Deployment_api",
  title: "api",
  icon: "logs",
  type: "logs",
  props: { context: "prod", namespace: "checkout", kubeConfig: "/k", object: "deployment/api" },
};
const SHELL = {
  id: "shell_prod_payments_api-1",
  title: "api-1",
  icon: "shell",
  type: "shell",
  props: { context: "prod", namespace: "payments", kubeConfig: "/k", pod: { metadata: { name: "api-1" } } },
};
const contexts = [{ context: "prod", kubeConfig: "/k", namespaces: ["all"] }];

const tabsRecord = (): WindowRecord => ({
  label: "pop-a1",
  kind: "tabs",
  route: null,
  contexts,
  tabs: { tabs: [LOGS, SHELL] as never, activeTabId: SHELL.id },
  bounds: { x: 10, y: 20, width: 900, height: 600 },
  attach: { [SHELL.id]: "session-1" },
});

describe("window labels", () => {
  it("makes pop-out labels Tauri accepts", () => {
    const label = newWindowLabel(1_700_000_000_000);
    expect(isPopOutLabel(label)).toBe(true);
    expect(newWindowLabel(1)).not.toBe(newWindowLabel(1));
  });

  it("only treats pop-out labels as pop-outs", () => {
    expect(isPopOutLabel("main")).toBe(false);
    expect(isPopOutLabel("pop-")).toBe(false);
    expect(isPopOutLabel("pop-Ab")).toBe(false);
    expect(isPopOutLabel(3)).toBe(false);
  });
});

describe("window payloads", () => {
  it("accepts view and tab windows", () => {
    expect(parsePayload({ kind: "view", route: "/pods", contexts, tabs: {} })).toEqual({
      kind: "view",
      route: "/pods",
      contexts,
      tabs: { tabs: [], activeTabId: null },
    });
    expect(parsePayload({ kind: "tabs", contexts, tabs: { tabs: [LOGS] } })?.tabs.tabs).toHaveLength(1);
  });

  it("rejects payloads without anything to show", () => {
    expect(parsePayload({ kind: "view", route: null })).toBeNull();
    expect(parsePayload({ kind: "view", route: "pods" })).toBeNull();
    expect(parsePayload({ kind: "tabs", tabs: { tabs: [] } })).toBeNull();
    expect(parsePayload({ kind: "dock" })).toBeNull();
    expect(parsePayload(null)).toBeNull();
  });

  it("keeps shell handovers for tabs it has", () => {
    const payload = parsePayload({
      kind: "tabs",
      contexts,
      tabs: { tabs: [SHELL] },
      attach: { [SHELL.id]: "session-1", other: "session-2", [LOGS.id]: 4 },
    });
    expect(payload?.attach).toEqual({ [SHELL.id]: "session-1" });
  });

  it("drops invalid contexts", () => {
    const payload = parsePayload({
      kind: "view",
      route: "/pods",
      contexts: [...contexts, { context: "", kubeConfig: "/k", namespaces: ["all"] }, { context: "x" }],
    });
    expect(payload?.contexts).toEqual(contexts);
  });
});

describe("stored windows", () => {
  it("parses records, without live sessions or duplicates", () => {
    const records = parseWindowRecords([
      tabsRecord(),
      { ...tabsRecord(), kind: "view", route: "/pods" },
      { label: "main", kind: "view", route: "/pods" },
      { label: "pop-b2", kind: "view", route: "/pods", bounds: { x: 0, y: 0, width: 50, height: 50 } },
      "nonsense",
    ]);
    expect(records.map((r) => r.label)).toEqual(["pop-a1", "pop-b2"]);
    expect(records[0].attach).toBeUndefined();
    expect(records[0].bounds).toEqual({ x: 10, y: 20, width: 900, height: 600 });
    // Too small to be a real window.
    expect(records[1].bounds).toBeNull();
    expect(parseWindowRecords("x")).toEqual([]);
  });

  it("applies a window's report", () => {
    const record = applyReport(tabsRecord(), {
      label: "pop-a1",
      tabs: { tabs: [LOGS] as never, activeTabId: LOGS.id },
      bounds: { x: 100.4, y: 50, width: 1000, height: 700 },
      route: "/ignored-for-tab-windows",
    });
    expect(record.tabs.tabs.map((t) => t.id)).toEqual([LOGS.id]);
    expect(record.bounds).toEqual({ x: 100, y: 50, width: 1000, height: 700 });
    expect(record.route).toBeNull();
    expect(record.attach).toBeUndefined();
  });

  it("follows the route of a view window", () => {
    const view: WindowRecord = { ...tabsRecord(), kind: "view", route: "/pods", tabs: { tabs: [], activeTabId: null } };
    expect(applyReport(view, { label: "pop-a1", route: "/services" }).route).toBe("/services");
  });

  it("stores records without the shell handover", () => {
    const [stored] = storableRecords([tabsRecord()]);
    expect(stored.attach).toBeUndefined();
    expect(stored.label).toBe("pop-a1");
  });
});

describe("tab transfers", () => {
  it("parses a tab moving between windows", () => {
    expect(parseTabTransfer({ label: "pop-a1", tab: SHELL, session: "s1" })).toEqual({
      label: "pop-a1",
      tab: SHELL,
      session: "s1",
    });
    expect(parseTabTransfer({ label: "pop-a1", tab: LOGS })?.session).toBeUndefined();
    expect(parseTabTransfer({ label: "pop-a1", tab: { id: "x" } })).toBeNull();
    expect(parseTabTransfer(undefined)).toBeNull();
  });
});

it("titles windows", () => {
  expect(windowTitle("Pods", "prod")).toBe("Pods — prod");
  expect(windowTitle("api", null)).toBe("api");
  expect(windowTitle("", "")).toBe("JET Pilot");
});
