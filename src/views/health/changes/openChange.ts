/*
 * Opening a change: its diff in a tab when it has one (a rollout, an edit
 * the recorder saw, Helm values), else the object in the side panel.
 */
import { defineAsyncComponent, markRaw } from "vue";
import type { SidePanel } from "@/providers/PanelProvider";
import { followRef } from "@/lib/resources/open";
import type { Change } from "@/lib/changes/model";

const ChangeDiff = markRaw(defineAsyncComponent(() => import("./ChangeDiff.vue")));

type AddTab = (id: string, title: string, component: any, props?: any, icon?: string) => void;

/* Helm releases aren't Kubernetes objects: there is nothing to open in the panel. */
export const canOpenObject = (change: Change) => change.object.apiVersion !== "helm.sh/v3" && change.kind !== "deleted";

export function openDiff(addTab: AddTab, change: Change) {
  if (!change.diff) return;
  addTab(
    `change-diff_${change.target.context}_${change.key}`,
    `${change.object.name}: ${change.diff.beforeLabel} → ${change.diff.afterLabel}`,
    ChangeDiff,
    { change },
    "history"
  );
}

export function openObject(
  setSidePanel: (panel: SidePanel | null) => void,
  current: SidePanel | null,
  change: Change
) {
  if (!canOpenObject(change)) return;
  const { kind, name, namespace, apiVersion } = change.object;
  void followRef(setSidePanel, current, change.target, { kind, name, namespace, apiVersion });
}

/** The click on a change: the diff, else the object. */
export function openChange(
  addTab: AddTab,
  setSidePanel: (panel: SidePanel | null) => void,
  current: SidePanel | null,
  change: Change
) {
  if (change.diff) openDiff(addTab, change);
  else openObject(setSidePanel, current, change);
}
