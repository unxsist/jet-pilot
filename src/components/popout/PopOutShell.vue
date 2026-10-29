<script setup lang="ts">
/*
 * A pop-out window's content (see @/lib/windows):
 * - "tabs": bottom-panel tabs filling the window, the tab strip doubling as
 *   the title bar;
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
const title = computed(() =>
  isView
    ? windowTitle(view.value.title, context.value)
    : windowTitle(activeTab.value?.title ?? "Tabs", activeTab.value?.props?.context ?? null)
);
watch(title, (value) => void current.setTitle(value).catch(() => undefined), { immediate: true });

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
  <!-- Bottom-panel tabs: the tab strip is the title bar. -->
  <ResizablePanelGroup v-if="!isView" direction="vertical">
    <TabOrchestrator standalone>
      <template #leading>
        <div v-if="isMac" class="w-16 shrink-0" data-tauri-drag-region />
      </template>
      <template #trailing>
        <WindowControls v-if="!isMac" class="ml-1" @close="close" />
      </template>
    </TabOrchestrator>
  </ResizablePanelGroup>

  <!-- A view: title bar, then the view on the same inset canvas as the main window. -->
  <div v-else class="flex h-full w-full flex-col">
    <header class="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2" data-tauri-drag-region>
      <!-- Room for the traffic lights -->
      <div v-if="isMac" class="w-16 shrink-0" data-tauri-drag-region />
      <KindIcon :name="view.icon" class="h-3.5 w-3.5 text-muted-foreground" />
      <span class="truncate text-xs font-semibold tracking-tight text-foreground" data-tauri-drag-region>
        {{ view.title }}
      </span>
      <span
        v-if="context"
        class="truncate text-xs text-muted-foreground"
        data-tauri-drag-region
      >
        {{ context }}<template v-if="namespace"> · {{ namespace }}</template>
      </span>
      <div class="ml-auto flex shrink-0 items-center gap-1" data-tauri-drag-region>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          aria-label="Move the view to the main window"
          title="Move to main window"
          @click="viewToMain"
        >
          <SquareArrowDownLeft class="h-3.5 w-3.5" />
        </Button>
        <WindowControls v-if="!isMac" @close="close" />
      </div>
    </header>
    <div class="flex min-h-0 flex-1 px-1.5 pb-1.5" data-tauri-drag-region>
      <div
        class="relative flex min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs"
      >
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>
            <RouterViewport v-if="viewReady" />
          </ResizablePanel>
          <ResizableHandle />
          <SidePanel />
        </ResizablePanelGroup>
      </div>
    </div>
  </div>
</template>
