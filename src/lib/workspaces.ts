/**
 * Workspaces: named snapshots of a working set — the active contexts with
 * their namespaces, the open bottom-panel tabs, the port-forward profiles
 * that were running and the current view. Switching workspaces saves the
 * current state into the active workspace first, then applies the target.
 */
import { parseTabSession, type TabSession } from "@/lib/tabDescriptors";

export interface WorkspaceContext {
  context: string;
  kubeConfig: string;
  /** ["all"] = all namespaces. */
  namespaces: string[];
}

export interface WorkspaceState {
  contexts: WorkspaceContext[];
  tabs: TabSession;
  /** Ids of port-forward profiles (see portForwardProfiles.ts). */
  portForwardProfileIds: string[];
  /** Full path of the view (e.g. "/deployments?resource=…"). */
  route: string | null;
}

export interface Workspace extends WorkspaceState {
  id: string;
  name: string;
  updatedAt: number;
}

export const MAX_WORKSPACES = 20;

let counter = 0;
const newId = (now: number) =>
  `ws-${now.toString(36)}-${(counter++).toString(36)}`;

export function createWorkspace(
  name: string,
  state: WorkspaceState,
  now = Date.now(),
  id = newId(now)
): Workspace {
  return {
    id,
    name: name.trim() || "Workspace",
    ...cloneState(state),
    updatedAt: now,
  };
}

/** The workspace with its state replaced by `state`. */
export function updateWorkspace(
  workspace: Workspace,
  state: WorkspaceState,
  now = Date.now()
): Workspace {
  return { ...workspace, ...cloneState(state), updatedAt: now };
}

function cloneState(state: WorkspaceState): WorkspaceState {
  return JSON.parse(
    JSON.stringify({
      contexts: state.contexts,
      tabs: state.tabs,
      portForwardProfileIds: state.portForwardProfileIds,
      route: state.route,
    })
  );
}

/** "Workspace 1", "Workspace 2", … — the first name not taken. */
export function nextWorkspaceName(workspaces: { name: string }[]): string {
  const taken = new Set(workspaces.map((w) => w.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = `Workspace ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/** Short description, e.g. "prod-eu, staging · 3 tabs · 1 forward". */
export function describeWorkspace(workspace: WorkspaceState): string {
  const contexts = workspace.contexts.map((c) => c.context);
  const parts = [
    contexts.length === 0
      ? "no contexts"
      : contexts.length <= 2
        ? contexts.join(", ")
        : `${contexts.slice(0, 2).join(", ")} +${contexts.length - 2}`,
  ];
  if (workspace.tabs.tabs.length > 0) {
    parts.push(plural(workspace.tabs.tabs.length, "tab"));
  }
  if (workspace.portForwardProfileIds.length > 0) {
    parts.push(plural(workspace.portForwardProfileIds.length, "forward"));
  }
  return parts.join(" · ");
}

function parseContexts(value: unknown): WorkspaceContext[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c) =>
        !!c &&
        typeof c.context === "string" &&
        c.context !== "" &&
        typeof c.kubeConfig === "string" &&
        Array.isArray(c.namespaces) &&
        c.namespaces.length > 0 &&
        c.namespaces.every((n: unknown) => typeof n === "string")
    )
    .map((c) => ({
      context: c.context,
      kubeConfig: c.kubeConfig,
      namespaces: [...c.namespaces],
    }));
}

/** Validates stored workspaces; drops invalid ones and duplicate ids. */
export function parseWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return [];
  const workspaces: Workspace[] = [];
  for (const raw of value) {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      workspaces.some((w) => w.id === raw.id)
    ) {
      continue;
    }
    workspaces.push({
      id: raw.id,
      name: raw.name,
      contexts: parseContexts(raw.contexts),
      tabs: parseTabSession(raw.tabs),
      portForwardProfileIds: Array.isArray(raw.portForwardProfileIds)
        ? raw.portForwardProfileIds.filter(
            (id: unknown) => typeof id === "string"
          )
        : [],
      route: typeof raw.route === "string" ? raw.route : null,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    });
  }
  return workspaces.slice(0, MAX_WORKSPACES);
}

/** Moves a workspace (for the hotbar order: Mod+Alt+1..9). */
export function moveWorkspace(
  workspaces: Workspace[],
  id: string,
  toIndex: number
): Workspace[] {
  const from = workspaces.findIndex((w) => w.id === id);
  if (from === -1) return workspaces;
  const next = [...workspaces];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
  return next;
}
