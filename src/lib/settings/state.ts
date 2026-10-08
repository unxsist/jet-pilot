/*
 * Session state and UI-managed collections (state.json). Unlike the
 * preferences these have no registry definitions: they are written whole.
 */
import type { AppState } from "./types";
import { noCountedPeriods } from "@/lib/usage";

export const STATE_FILE = "state.json";

/** The state keys (dotted paths); everything else in `Settings` is a preference. */
export const STATE_KEYS = [
  "lastKubeConfig",
  "lastContext",
  "lastNamespace",
  "activeContexts",
  "PanelProvider",
  "clusters",
  "collapsedNavigationGroups",
  "pinnedResources",
  "updates.whatsNew",
  "updates.dismissedAnnouncements",
  "updates.counted",
  "openTabs",
  "portForwardProfiles",
  "workspaces",
  "activeWorkspaceId",
  "recentCommands",
  "welcomeCompleted",
] as const;

export function stateDefaults(): AppState {
  return {
    lastKubeConfig: null,
    lastContext: null,
    lastNamespace: null,
    activeContexts: [],
    PanelProvider: { height: 50 },
    clusters: [],
    collapsedNavigationGroups: [],
    pinnedResources: [],
    updates: { whatsNew: null, dismissedAnnouncements: [], counted: noCountedPeriods() },
    openTabs: null,
    portForwardProfiles: [],
    workspaces: [],
    activeWorkspaceId: null,
    recentCommands: [],
    welcomeCompleted: null,
  };
}
