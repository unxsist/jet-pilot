/**
 * Serializable descriptions of bottom-panel tabs, used to restore open tabs
 * on start and to store them in workspaces.
 *
 * Tabs are opened with `addTab(id, title, component, props, icon)` from many
 * places; the tab type is inferred from the icon + props so callers need no
 * changes. Only plain, whitelisted props are stored (no row objects, no
 * functions). Tabs that cannot be restored meaningfully are skipped: "create"
 * editors (unsaved content), `kubectl debug` sessions (ephemeral containers,
 * node shells: they create objects in the cluster) and unknown tab kinds.
 *
 * Pod shells and local terminals are restored as a "Reconnect" placeholder
 * (see `isPtyTabType`): they never start a process without a user action.
 */

export type TabType = "logs" | "describe" | "edit" | "shell" | "terminal";

export interface TabDescriptor {
  id: string;
  title: string;
  icon: string;
  type: TabType;
  props: Record<string, unknown>;
}

export interface TabSession {
  tabs: TabDescriptor[];
  activeTabId: string | null;
}

/** The tab as the panel knows it (component excluded). */
export interface TabLike {
  id: string;
  title: string;
  icon: string;
  props?: Record<string, any>;
}

const TARGET_KEYS = ["context", "namespace", "kubeConfig"] as const;

const PROP_KEYS: Record<TabType, string[]> = {
  logs: [...TARGET_KEYS, "object", "container"],
  describe: [...TARGET_KEYS, "type", "name"],
  edit: [...TARGET_KEYS, "type", "kind", "name", "useKubeCtl"],
  shell: [...TARGET_KEYS],
  terminal: [...TARGET_KEYS],
};

export function inferTabType(tab: TabLike): TabType | null {
  const props = tab.props || {};
  switch (tab.icon) {
    case "logs":
      return typeof props.object === "string" ? "logs" : null;
    case "describe":
      return "describe";
    case "edit":
      return props.create ? null : "edit";
    case "shell":
      // Node shells (DebugShell.vue) run `kubectl debug node/...`: a
      // privileged pod per session, never started again on restore.
      if ("argv" in props || "cleanupDebugPod" in props) return null;
      return props.pod ? "shell" : "terminal";
    default:
      return null;
  }
}

/** Tab types that run a process in a pty (kubectl exec, a local shell). */
export function isPtyTabType(type: TabType): boolean {
  return type === "shell" || type === "terminal";
}

/*
 * Tab id prefixes of `kubectl debug` sessions. Older versions stored node
 * shells as terminals; those are dropped when a session is parsed.
 */
const DEBUG_TAB_ID_PREFIXES = ["node-shell/", "debug/"];

const isPlain = (value: unknown) =>
  value === null ||
  ["string", "number", "boolean"].includes(typeof value);

/** The descriptor of a tab, or null when it is not restorable. */
export function describeTab(tab: TabLike): TabDescriptor | null {
  const type = inferTabType(tab);
  if (!type) return null;

  const source = tab.props || {};
  const props: Record<string, unknown> = {};
  for (const key of PROP_KEYS[type]) {
    if (key in source && isPlain(source[key])) {
      props[key] = source[key];
    }
  }

  if (typeof props.context !== "string" || !props.context) {
    return null;
  }

  if (type === "shell") {
    // Shell.vue only needs the pod name and the container names.
    const pod = source.pod;
    const name = pod?.metadata?.name;
    if (typeof name !== "string") return null;
    props.pod = {
      metadata: { name, namespace: pod.metadata?.namespace },
      spec: {
        containers: (pod.spec?.containers || [])
          .map((c: { name?: string }) => ({ name: c?.name }))
          .filter((c: { name?: string }) => typeof c.name === "string"),
      },
    };
    if (typeof source.container?.name === "string") {
      props.container = { name: source.container.name };
    }
  }

  if (type === "describe" || type === "edit") {
    if (typeof props.name !== "string" || !props.name) return null;
  }

  return { id: tab.id, title: tab.title, icon: tab.icon, type, props };
}

export function describeTabs(
  tabs: TabLike[],
  activeTabId: string | null
): TabSession {
  const descriptors = tabs
    .map(describeTab)
    .filter((d): d is TabDescriptor => d !== null);
  return {
    tabs: descriptors,
    activeTabId: descriptors.some((d) => d.id === activeTabId)
      ? activeTabId
      : descriptors[descriptors.length - 1]?.id ?? null,
  };
}

const TAB_TYPES: TabType[] = ["logs", "describe", "edit", "shell", "terminal"];

/** Validates stored data (settings / workspaces); drops anything invalid. */
export function parseTabSession(value: unknown): TabSession {
  const raw = value as Partial<TabSession> | null | undefined;
  const tabs = (Array.isArray(raw?.tabs) ? raw!.tabs : []).filter(
    (d): d is TabDescriptor =>
      !!d &&
      typeof d.id === "string" &&
      typeof d.title === "string" &&
      typeof d.icon === "string" &&
      TAB_TYPES.includes(d.type) &&
      !!d.props &&
      typeof d.props === "object" &&
      typeof d.props.context === "string" &&
      !DEBUG_TAB_ID_PREFIXES.some((prefix) => d.id.startsWith(prefix))
  );
  const unique = tabs.filter(
    (d, index) => tabs.findIndex((t) => t.id === d.id) === index
  );
  const activeTabId =
    typeof raw?.activeTabId === "string" &&
    unique.some((d) => d.id === raw.activeTabId)
      ? raw.activeTabId
      : unique[unique.length - 1]?.id ?? null;
  return { tabs: unique, activeTabId };
}
