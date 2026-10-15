/*
 * The side panel's trail: following a link in a panel (an owner, a node, a
 * claim) remembers the panel you came from, so Back returns there. Opening
 * a panel any other way (a table row, the graph) starts a fresh trail.
 * Tiny on purpose: the side panel's header loads it at startup.
 */
import { shallowRef, toRaw } from "vue";
import type { SidePanel } from "@/providers/PanelProvider";

/** Panels to go back to, the most recent last. */
export const panelTrail = shallowRef<SidePanel[]>([]);
let following: SidePanel | null = null;

/** A link in `current` is about to open `next`. */
export function followPanel(current: SidePanel | null, next: SidePanel) {
  panelTrail.value = current ? [...panelTrail.value, toRaw(current)].slice(-20) : [];
  following = next;
}

/** Called by the side panel whenever its content changes. */
export function notePanelChange(panel: SidePanel | null) {
  if ((panel ? toRaw(panel) : null) !== following) panelTrail.value = [];
  following = null;
}

/** Back to the previous panel of the trail. */
export function panelBack(setSidePanel: (panel: SidePanel | null) => void) {
  const trail = panelTrail.value;
  const previous = trail[trail.length - 1];
  if (!previous) return;
  panelTrail.value = trail.slice(0, -1);
  following = previous;
  setSidePanel(previous);
}
