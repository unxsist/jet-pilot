/**
 * Bottom-panel tabs arriving from another window (see @/lib/windows).
 */
import type { Ref } from "vue";
import type { TabSession } from "@/lib/tabDescriptors";
import type { PanelSession, Tab } from "@/providers/PanelProvider";

/**
 * Opens tabs that moved here (like a restored session: lazily) and shows
 * the active one right away. Running shells (`attach`: tab id → pty
 * session) are attached to instead of waiting for "Reconnect".
 */
export function openMovedTabs(
  panel: PanelSession,
  tabs: Ref<Tab[]>,
  session: TabSession,
  attach: Record<string, string> = {}
) {
  panel.restore(session);
  for (const tab of tabs.value) {
    const pty = attach[tab.id];
    if (!pty) continue;
    tab.props = { ...tab.props, attachSession: pty };
    tab.reconnect = false;
    tab.lazy = false;
  }
  const active = tabs.value.find((tab) => tab.id === session.activeTabId);
  if (active && !active.reconnect) {
    active.lazy = false;
    active.quiet = false;
  }
}
