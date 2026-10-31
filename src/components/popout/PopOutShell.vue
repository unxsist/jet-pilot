<script setup lang="ts">
/*
 * A pop-out window's content (see @/lib/windows), under a title bar that
 * names what it shows and offers the way back to the main window:
 * - "tabs": bottom-panel tabs filling the window (a tab strip only once
 *   there is more than one);
 * - "view": a resource view with its own navigation, side panel and tabs.
 *
 * It opens what the main window sent (running shells attach), reports open
 * tabs, the view's route and the window's position back so the main window
 * can restore it, and offers the way back to the main window.
 */
import { SquareArrowDownLeft } from "lucide-vue-next";
import { useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import KindIcon from "@/components/KindIcon.vue";
import TabIcon from "@/components/TabIcon.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
import WindowControls from "@/components/popout/WindowControls.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { injectStrict } from "@/lib/utils";
import { error as logError } from "@/lib/logger";
import { releasePtyTab } from "@/lib/pty";
import { openMovedTabs } from "@/lib/movedTabs";
import { viewTitle } from "@/lib/viewTitle";
import {
  MAIN_WINDOW,
  PopOutKey,
  type WindowBounds,
  type WindowPayload,
  type WindowStateReport,
} from "@/lib/windows";
import { windowTitle, WINDOW_EVENTS } from "@/lib/windowRecords";
import {
  PanelProviderSessionKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";

const SidePanel = defineAsyncComponent(() => import("@/components/SidePanel.vue"));

const props = defineProps<{
  label: string;
  payload: WindowPayload;
}>();

const router = useRouter();
const panel = injectStrict(PanelProviderSessionKey);
const { tabs, activeTabId } = injectStrict(PanelProviderStateKey);
const { context, namespace } = injectStrict(KubeContextStateKey);
const current = getCurrentWebviewWindow();
const isMac = getOsType() === "macos";
const isView = props.payload.kind === "view";

/* ------------------------------------------------------------- content -- */

openMovedTabs(panel, tabs, props.payload.tabs, props.payload.attach);

/* The view's route, once the router got there (the app starts at "/"). */
const viewReady = ref(!isView);
if (isView && props.payload.route) {
  const route = props.payload.route;
  router
    .isReady()
    .then(() => router.replace(route))
    .catch((e) => logError(`Failed to open ${route}: ${e}`))
    .finally(() => (viewReady.value = true));
}

const view = computed(() => viewTitle(router.currentRoute.value));
const activeTab = computed(
  () => tabs.value.find((t) => t.id === activeTabId.value) ?? null
);
/* Title bar: what the window shows, and where (cluster · namespace). */
const heading = computed(() => {
  if (isView) {
    return {
      title: view.value.title,
      where: [context.value, namespace.value].filter(Boolean).join(" · "),
    };
  }
  const tabProps = activeTab.value?.props ?? {};
  return {
    title: activeTab.value?.title ?? "",
    where: [tabProps.context, tabProps.namespace].filter(Boolean).join(" · "),
  };
});
watch(
  () => windowTitle(heading.value.title, heading.value.where),
  (value) => void current.setTitle(value).catch(() => undefined),
  { immediate: true }
);

/* View windows move with their tabs; tab windows move the tab on show. */
const toMain = () =>
  isView ? viewToMain() : activeTabId.value ? moveTabToMain(activeTabId.value) : undefined;

/* ----------------------------------------------- reports to the main window -- */

let pending: Omit<WindowStateReport, "label"> = {};
let reportTimer: ReturnType<typeof setTimeout> | null = null;
const report = (patch: Omit<WindowStateReport, "label">) => {
  pending = { ...pending, ...patch };
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    const message: WindowStateReport = { label: props.label, ...pending };
    pending = {};
    reportTimer = null;
    void emitTo(MAIN_WINDOW, WINDOW_EVENTS.state, message).catch(() => undefined);
  }, 250);
};

watch(
  () => [activeTabId.value, tabs.value.map((t) => `${t.id}\u0000${t.title}`).join("\u0001")],
  () => report({ tabs: panel.snapshot() }),
  { immediate: true }
);
if (isView) {
  watch(
    () => router.currentRoute.value.fullPath,
    (route) => {
      if (viewReady.value) report({ route });
    }
  );
}

const reportBounds = async () => {
  try {
    const scale = await current.scaleFactor();
    const [position, size] = await Promise.all([current.outerPosition(), current.innerSize()]);
    const bounds: WindowBounds = {
      x: position.x / scale,
      y: position.y / scale,
      width: size.width / scale,
      height: size.height / scale,
    };
    report({ bounds });
  } catch {
    // Not available (e.g. Wayland positions): keep the last known bounds.
  }
};
const unlisteners = Promise.all([current.onMoved(reportBounds), current.onResized(reportBounds)]).catch(
  () => []
);

/* A tabs window without tabs has nothing left to show. */
watch(
  () => tabs.value.length,
  (count) => {
    if (!isView && count === 0) void current.destroy();
  }
);

/*
 * Closing the window closes its tabs; an editor with unsaved changes keeps
 * the window open and asks first (its own dialog).
 */
const closeRequested = current.onCloseRequested((event) => {
  for (const tab of tabs.value) {
    const movable = window.dispatchEvent(
      new CustomEvent("TabOrchestrator_TabMoving", { cancelable: true, detail: { id: tab.id } })
    );
    if (!movable) {
      event.preventDefault();
      activeTabId.value = tab.id;
      window.dispatchEvent(
        new CustomEvent("TabOrchestrator_TabClosed", { cancelable: true, detail: { id: tab.id } })
      );
      return;
    }
  }
});

onUnmounted(() => {
  void unlisteners.then((list) => list.forEach((unlisten) => unlisten()));
  void closeRequested.then((unlisten) => unlisten()).catch(() => undefined);
});

/* ------------------------------------------------------------ pop-out API -- */

const moveTabToMain = async (tabId: string) => {
  const descriptor = panel.describe(tabId);
  if (!descriptor) return;
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
  await emitTo(MAIN_WINDOW, WINDOW_EVENTS.tabToMain, {
    label: props.label,
    tab: descriptor,
    ...(session ? { session } : {}),
  });
  panel.closeTabs([tabId], { force: true });
};

const close = () => current.close();

const viewToMain = async () => {
  await emitTo(MAIN_WINDOW, WINDOW_EVENTS.viewToMain, {
    label: props.label,
    route: router.currentRoute.value.fullPath,
  });
  // Its tabs go along.
  for (const tab of [...tabs.value]) await moveTabToMain(tab.id);
  await current.destroy();
};

provide(PopOutKey, {
  label: props.label,
  payload: props.payload,
  moveTabToMain,
  viewToMain,
  close,
});
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <header class="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2" data-tauri-drag-region>
      <!-- Room for the traffic lights -->
      <div v-if="isMac" class="w-16 shrink-0" data-tauri-drag-region />
      <KindIcon v-if="isView" :name="view.icon" class="h-3.5 w-3.5 text-muted-foreground" />
      <TabIcon v-else-if="activeTab" :name="activeTab.icon" class="text-muted-foreground" />
      <span
        class="truncate text-xs font-semibold tracking-tight text-foreground"
        data-tauri-drag-region
      >
        {{ heading.title }}
      </span>
      <span v-if="heading.where" class="truncate text-xs text-muted-foreground" data-tauri-drag-region>
        {{ heading.where }}
      </span>
      <div class="ml-auto flex shrink-0 items-center gap-1" data-tauri-drag-region>
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          :title="isView ? 'The view and its tabs go back to the main window' : 'This tab goes back to the main window'"
          @click="toMain"
        >
          <SquareArrowDownLeft class="h-3.5 w-3.5" />
          {{ !isView && tabs.length > 1 ? "Move tab to main window" : "Move to main window" }}
        </Button>
        <WindowControls v-if="!isMac" @close="close" />
      </div>
    </header>
    <!-- The content on the same inset canvas as the main window. -->
    <div class="flex min-h-0 flex-1 px-1.5 pb-1.5" data-tauri-drag-region>
      <div
        class="relative flex min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs"
      >
        <ResizablePanelGroup v-if="isView" direction="horizontal">
          <ResizablePanel>
            <RouterViewport v-if="viewReady" />
          </ResizablePanel>
          <ResizableHandle />
          <SidePanel />
        </ResizablePanelGroup>
        <ResizablePanelGroup v-else direction="vertical">
          <TabOrchestrator standalone />
        </ResizablePanelGroup>
      </div>
    </div>
  </div>
</template>
