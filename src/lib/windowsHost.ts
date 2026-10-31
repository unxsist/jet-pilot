/**
 * The main window's side of pop-out windows (see @/lib/windows), loaded
 * once the app has settled, or on first use (WindowsProvider): opens
 * windows, answers their requests, keeps them in state.json, reopens them
 * on start and offers the palette commands.
 */
import type { Ref } from "vue";
import type { Router } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "@/components/ui/toast";
import { error as logError } from "@/lib/logger";
import { releasePtyTab } from "@/lib/pty";
import { openMovedTabs } from "@/lib/movedTabs";
import type { TabDescriptor } from "@/lib/tabDescriptors";
import { isFullWidthPath } from "@/lib/splitView";
import { viewTitle } from "@/lib/viewTitle";
import type { Settings } from "@/lib/settings/types";
import type { PanelSession, Tab } from "@/providers/PanelProvider";
import type { SplitView } from "@/providers/SplitViewProvider";
import type { Command } from "@/command-palette";
import {
  isQuitting,
  MAIN_WINDOW,
  type WindowRecord,
  type WindowStateReport,
} from "@/lib/windows";
import {
  applyReport,
  newWindowLabel,
  parseTabTransfer,
  parseWindowRecords,
  storableRecords,
  windowTitle,
  WINDOW_EVENTS,
} from "@/lib/windowRecords";

export interface WindowsHostContext {
  router: Router;
  settings: Ref<Settings>;
  context: Ref<string>;
  contexts: Ref<Map<string, string[]>>;
  contextKubeConfigMapping: Ref<Map<string, string>>;
  tabs: Ref<Tab[]>;
  activeTabId: Ref<string | null>;
  panel: PanelSession;
  split: SplitView;
  registerCommand: (command: Command) => void;
}

export interface WindowsHost {
  openView(path: string, options?: { closePane?: number }): Promise<void>;
  moveTab(tabId: string): Promise<void>;
  dispose(): void;
}

/* Size of a new window (logical px); the backend centers it. */
const NEW_WINDOW_SIZE = {
  tabs: { width: 960, height: 600 },
  view: { width: 1120, height: 760 },
};

export function createWindowsHost(ctx: WindowsHostContext): WindowsHost {
  const { router, settings, panel, split } = ctx;
  const current = getCurrentWebviewWindow();

  /* Live records: the stored ones plus the one-off shell handovers. */
  let records: WindowRecord[] = parseWindowRecords(settings.value.windows);
  const persist = () => {
    settings.value.windows = storableRecords(records);
  };
  const update = (label: string, change: (record: WindowRecord) => WindowRecord | null) => {
    records = records.flatMap((record) => {
      if (record.label !== label) return [record];
      const next = change(record);
      return next ? [next] : [];
    });
    persist();
  };

  const activeContexts = () =>
    [...ctx.contexts.value.entries()].map(([name, namespaces]) => ({
      context: name,
      kubeConfig: ctx.contextKubeConfigMapping.value.get(name) || "",
      namespaces: [...namespaces],
    }));

  const titleOf = (record: WindowRecord) => {
    if (record.kind === "view" && record.route) {
      return windowTitle(viewTitle(router.resolve(record.route)).title, record.contexts[0]?.context);
    }
    const tab =
      record.tabs.tabs.find((t) => t.id === record.tabs.activeTabId) ?? record.tabs.tabs[0];
    return windowTitle(tab?.title ?? "Tabs", tab ? String(tab.props.context ?? "") : null);
  };

  const open = (record: WindowRecord) => {
    const size = record.bounds ?? NEW_WINDOW_SIZE[record.kind];
    return invoke("window_open", {
      label: record.label,
      url: "/",
      title: titleOf(record),
      width: size.width,
      height: size.height,
      x: record.bounds?.x ?? null,
      y: record.bounds?.y ?? null,
    });
  };

  const add = async (record: WindowRecord) => {
    records = [...records, record];
    persist();
    try {
      await open(record);
    } catch (e) {
      update(record.label, () => null);
      throw e;
    }
  };

  /* A tab (back) in this window's bottom panel; a running shell reattaches. */
  const openTab = (tab: TabDescriptor, session?: string) =>
    openMovedTabs(panel, ctx.tabs, { tabs: [tab], activeTabId: tab.id }, session ? { [tab.id]: session } : {});

  const openFailed = (e: unknown) => {
    logError(`Failed to open a window: ${e}`);
    toast({ title: "The window could not be opened", description: String(e), variant: "destructive" });
  };

  /* ------------------------------------------------------------- API -- */

  const moveTab = async (tabId: string) => {
    const descriptor = panel.describe(tabId);
    if (!descriptor) {
      toast({
        title: "This tab can't move to a window",
        description: "New objects and debug sessions stay in the main window.",
      });
      return;
    }
    // An editor with unsaved changes vetoes (it keeps them here).
    const movable = window.dispatchEvent(
      new CustomEvent("TabOrchestrator_TabMoving", { cancelable: true, detail: { id: tabId } })
    );
    if (!movable) {
      toast({ title: "Save or discard your changes first", description: descriptor.title });
      return;
    }
    const session = releasePtyTab(tabId);
    if (session) {
      await invoke("tty_release", { sessionId: session }).catch((e) =>
        logError(`Failed to hand over the terminal session: ${e}`)
      );
    }
    const record: WindowRecord = {
      label: newWindowLabel(),
      kind: "tabs",
      route: null,
      contexts: activeContexts(),
      tabs: { tabs: [descriptor], activeTabId: descriptor.id },
      bounds: null,
      ...(session ? { attach: { [descriptor.id]: session } } : {}),
    };
    try {
      await add(record);
    } catch (e) {
      openFailed(e);
      if (session) {
        // Take the shell back: the tab reattaches to it.
        panel.closeTabs([tabId], { force: true });
        openTab(descriptor, session);
      }
      return;
    }
    panel.closeTabs([tabId], { force: true });
  };

  const openView = async (path: string, options: { closePane?: number } = {}) => {
    if (isFullWidthPath(path)) return;
    try {
      await add({
        label: newWindowLabel(),
        kind: "view",
        route: path,
        contexts: activeContexts(),
        tabs: { tabs: [], activeTabId: null },
        bounds: null,
      });
    } catch (e) {
      openFailed(e);
      return;
    }
    if (options.closePane !== undefined && split.isSplit.value) split.close(options.closePane);
  };

  /* ---------------------------------------------- messages, lifecycle -- */

  const focusMain = () => invoke("window_focus", { label: MAIN_WINDOW }).catch(() => undefined);

  const unlisteners = Promise.all([
    current.listen<{ label: string }>(WINDOW_EVENTS.ready, ({ payload }) => {
      const record = records.find((r) => r.label === payload?.label);
      if (record) void emitTo(record.label, WINDOW_EVENTS.payload, record);
    }),
    current.listen<WindowStateReport>(WINDOW_EVENTS.state, ({ payload }) => {
      if (payload?.label) update(payload.label, (record) => applyReport(record, payload));
    }),
    current.listen(WINDOW_EVENTS.tabToMain, ({ payload }) => {
      const transfer = parseTabTransfer(payload);
      if (!transfer) return;
      openTab(transfer.tab, transfer.session);
      window.dispatchEvent(new Event("TabOrchestrator_Expand"));
      void focusMain();
    }),
    current.listen<{ label: string; route: string }>(WINDOW_EVENTS.viewToMain, ({ payload }) => {
      if (typeof payload?.route !== "string" || !payload.route.startsWith("/")) return;
      router.push(payload.route).catch(() => {});
      void focusMain();
    }),
    current.listen<{ label: string }>(WINDOW_EVENTS.closed, ({ payload }) => {
      // Windows closing because the app quits come back next time.
      if (isQuitting() || !payload?.label) return;
      update(payload.label, () => null);
    }),
  ]).catch((e) => {
    logError(`Pop-out windows are unavailable: ${e}`);
    return [];
  });

  /* Windows of the last session come back (listeners first: they ask). */
  void unlisteners.then(() => {
    for (const record of records) {
      open(record).catch((e) => logError(`Failed to reopen a window: ${e}`));
    }
  });

  const ready = <T>(fn: () => Promise<T>) => unlisteners.then(fn);

  /* ------------------------------------------------- command palette -- */

  ctx.registerCommand({
    id: "window-move-tab",
    name: "Move tab to new window",
    description: "The active bottom-panel tab in a window of its own",
    keywords: ["window", "pop out", "detach", "monitor", "undock"],
    execute: () => {
      if (ctx.activeTabId.value) void ready(() => moveTab(ctx.activeTabId.value!));
    },
  });
  ctx.registerCommand({
    id: "window-open-view",
    name: "Open view in new window",
    description: "The current view in a window of its own",
    keywords: ["window", "pop out", "detach", "monitor", "second screen"],
    execute: () => {
      const path = router.currentRoute.value.fullPath;
      if (ctx.context.value && !isFullWidthPath(path)) void ready(() => openView(path));
    },
  });

  return {
    openView: (path, options) => ready(() => openView(path, options)),
    moveTab: (tabId) => ready(() => moveTab(tabId)),
    dispose: () => {
      void unlisteners.then((list) => list.forEach((unlisten) => unlisten()));
    },
  };
}
