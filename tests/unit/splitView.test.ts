import { describe, expect, it } from "vitest";
import {
  clampSplitSize,
  focusPane,
  followRoute,
  isFullWidthPath,
  isSplit,
  singlePane,
  snapshotSplit,
  type SplitLayout,
} from "@/lib/splitView";
import {
  closePane,
  layoutFromSnapshot,
  openToSide,
  parseSplitSnapshot,
  swapPanes,
} from "@/lib/splitViewOps";
import { viewTitle } from "@/lib/viewTitle";

const PODS = "/pods?resource=pods&kind=Pod";
const DEPLOYMENTS = "/deployments?resource=deployments&kind=Deployment";
const SERVICES = "/services?resource=services&kind=Service";

const split = (): SplitLayout => ({
  panes: [
    { id: "a", path: PODS },
    { id: "b", path: DEPLOYMENTS },
  ],
  focused: 0,
});

describe("split view layout", () => {
  it("starts with one pane that follows the router", () => {
    const layout = followRoute(singlePane(PODS, "a"), DEPLOYMENTS);
    expect(layout).toEqual({ panes: [{ id: "a", path: DEPLOYMENTS }], focused: 0 });
    expect(isSplit(layout)).toBe(false);
  });

  it("keeps the same object when the route is already shown", () => {
    const layout = singlePane(PODS, "a");
    expect(followRoute(layout, PODS)).toBe(layout);
  });

  it("only moves the focused pane when the router navigates", () => {
    const layout = followRoute({ ...split(), focused: 1 }, SERVICES);
    expect(layout.panes.map((p) => p.path)).toEqual([PODS, SERVICES]);
  });

  it("opens a second pane on the right and focuses it", () => {
    const layout = openToSide(singlePane(PODS, "a"), DEPLOYMENTS, "b");
    expect(layout).toEqual({ ...split(), focused: 1 });
  });

  it("reuses the other pane of a split", () => {
    expect(openToSide(split(), SERVICES, "c")).toEqual({
      panes: [
        { id: "a", path: PODS },
        { id: "b", path: SERVICES },
      ],
      focused: 1,
    });
    expect(openToSide({ ...split(), focused: 1 }, SERVICES, "c").panes[0]).toEqual({
      id: "a",
      path: SERVICES,
    });
  });

  it("focuses existing panes only", () => {
    const layout = split();
    expect(focusPane(layout, 1).focused).toBe(1);
    expect(focusPane(layout, 0)).toBe(layout);
    expect(focusPane(layout, 5)).toBe(layout);
  });

  it("closes a pane and focuses the one that remains", () => {
    expect(closePane({ ...split(), focused: 1 }, 1)).toEqual({
      panes: [{ id: "a", path: PODS }],
      focused: 0,
    });
    expect(closePane(split(), 0)).toEqual({ panes: [{ id: "b", path: DEPLOYMENTS }], focused: 0 });
    const single = singlePane(PODS);
    expect(closePane(single, 0)).toBe(single);
  });

  it("swaps panes and keeps the focus on the same view", () => {
    const swapped = swapPanes(split());
    expect(swapped.panes.map((p) => p.id)).toEqual(["b", "a"]);
    expect(swapped.panes[swapped.focused].path).toBe(PODS);
  });
});

describe("split snapshots", () => {
  it("stores only real splits", () => {
    expect(snapshotSplit(singlePane(PODS))).toBeNull();
    expect(snapshotSplit({ ...split(), focused: 1 })).toEqual({
      panes: [PODS, DEPLOYMENTS],
      focused: 1,
    });
  });

  it("parses stored splits defensively", () => {
    expect(parseSplitSnapshot({ panes: [PODS, DEPLOYMENTS], focused: 1 })).toEqual({
      panes: [PODS, DEPLOYMENTS],
      focused: 1,
    });
    expect(parseSplitSnapshot({ panes: [PODS, DEPLOYMENTS], focused: 7 })?.focused).toBe(0);
    expect(parseSplitSnapshot({ panes: [PODS] })).toBeNull();
    expect(parseSplitSnapshot({ panes: [PODS, "/settings/general"] })).toBeNull();
    expect(parseSplitSnapshot({ panes: [PODS, 3] })).toBeNull();
    expect(parseSplitSnapshot(null)).toBeNull();
    expect(parseSplitSnapshot("x")).toBeNull();
  });

  it("restores a split, keeping pane ids of views already shown", () => {
    const layout = layoutFromSnapshot(
      { panes: [SERVICES, PODS], focused: 1 },
      singlePane(PODS, "a")
    );
    expect(layout.panes[1]).toEqual({ id: "a", path: PODS });
    expect(layout.panes[0].path).toBe(SERVICES);
    expect(layout.panes[0].id).not.toBe("a");
    expect(layout.focused).toBe(1);
  });
});

describe("split view helpers", () => {
  it("knows the full-width pages", () => {
    expect(isFullWidthPath("/settings")).toBe(true);
    expect(isFullWidthPath("/settings/general")).toBe(true);
    expect(isFullWidthPath("/settings?focus=search")).toBe(true);
    expect(isFullWidthPath("/settingsfoo")).toBe(false);
    expect(isFullWidthPath(PODS)).toBe(false);
    expect(isFullWidthPath("/clusters")).toBe(false);
  });

  it("clamps the stored pane size", () => {
    expect(clampSplitSize(undefined)).toBe(50);
    expect(clampSplitSize(5)).toBe(20);
    expect(clampSplitSize(95)).toBe(80);
    expect(clampSplitSize(62.5)).toBe(62.5);
  });

  it("titles views", () => {
    expect(viewTitle({ name: "Pods", query: { resource: "pods", kind: "Pod" } })).toEqual({
      title: "Pods",
      icon: "pods",
    });
    expect(viewTitle({ name: "GenericResource", query: { resource: "ingresses", kind: "Ingress" } }).title).toBe(
      "Ingresses"
    );
    expect(viewTitle({ name: "ClusterOverview" }).title).toBe("Resource Graph");
    expect(viewTitle({ name: "GenericResource", query: {} }).title).toBe("View");
  });
});
