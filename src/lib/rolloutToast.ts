/*
 * "Notify me" on the toast of a change that starts a rollout (a restart,
 * a scale, a rollback, a YAML edit, a Helm upgrade). Following loads with
 * the click (@/lib/rolloutNotify).
 */
import { h, inject, markRaw, type FunctionalComponent } from "vue";
/*
 * radix-vue's action with the app's ToastAction classes (like
 * lib/guardrails/guard.ts): ToastAction.vue would join the startup bundle.
 */
import { ToastAction } from "radix-vue";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import type { RolloutRef } from "./rolloutFollow";

const TOAST_ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center self-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/* Long enough to reach for the button; the toast would otherwise vanish in 2.5 s. */
const DURATION_MS = 10_000;

/*
 * The toast is rendered inside the panel provider: the side panel it opens
 * the workload in comes from there.
 */
const NotifyMeAction = (refs: RolloutRef[], name?: string): FunctionalComponent => () => {
  const setSidePanel = inject(PanelProviderSetSidePanelComponentKey, null);
  return h(
    ToastAction,
    {
      altText: "Notify me when the rollout finishes",
      class: TOAST_ACTION_CLASS,
      onClick: async () => (await import("./rolloutNotify")).followRollout(refs, { name, setSidePanel }),
    },
    () => "Notify me"
  );
};

/** Toast options that offer "Notify me" for `refs` (none: nothing to add). */
export function notifyMeOptions(refs: RolloutRef[], name?: string) {
  return refs.length > 0
    ? { action: markRaw(NotifyMeAction(refs, name)), duration: DURATION_MS, autoDismiss: false }
    : {};
}
