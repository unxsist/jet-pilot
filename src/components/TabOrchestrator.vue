<script setup lang="ts">
import {
  PanelProviderStateKey,
  PanelProviderCloseTabKey,
  TabClosedEvent,
} from "@/providers/PanelProvider";
import { injectStrict } from "@/lib/utils";
import TabIcon from "@/components/TabIcon.vue";
import { ChevronDown, Columns2, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

import { ResizablePanel } from "@/components/ui/resizable";
import { useEventListener } from "@vueuse/core";

const { tabs, activeTabId } = injectStrict(PanelProviderStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const closeTab = injectStrict(PanelProviderCloseTabKey);

const state = reactive({
  open: true,
  rerenderKey: 0,
});

useEventListener(window, "TabOrchestrator_Expand", () => (state.open = true));

/*
 * Split view: a second tab next to the active one (e.g. logs next to a
 * shell). Alt+click (or the split button) puts a tab on the right; the
 * tabs are not moved in the DOM, so terminals and log streams keep running.
 */
const splitTabId = ref<string | null>(null);
const previousTabId = ref<string | null>(null);

const showOnRight = (id: string) => {
  if (id === activeTabId.value) {
    // Swap: the right tab becomes the main one.
    if (!splitTabId.value) return;
    const right = splitTabId.value;
    splitTabId.value = id;
    setActiveTab(right);
    return;
  }
  splitTabId.value = id;
  const tab = tabs.value.find((t) => t.id === id);
  if (tab?.lazy) tab.lazy = false;
  if (!state.open) state.open = true;
};

const toggleSplit = () => {
  if (splitTabId.value) {
    splitTabId.value = null;
    return;
  }
  const candidate =
    tabs.value.find(
      (t) => t.id === previousTabId.value && t.id !== activeTabId.value
    ) ?? tabs.value.find((t) => t.id !== activeTabId.value);
  if (candidate) showOnRight(candidate.id);
};

watch(activeTabId, (_id, previous) => {
  if (previous) previousTabId.value = previous;
  if (splitTabId.value && splitTabId.value === activeTabId.value) {
    splitTabId.value = previous ?? null;
  }
});

watch(
  () => tabs.value.map((t) => t.id),
  (ids) => {
    if (splitTabId.value && !ids.includes(splitTabId.value)) {
      splitTabId.value = null;
    }
  }
);

const isVisible = (id: string) =>
  id === activeTabId.value || id === splitTabId.value;

const onTabClick = (event: MouseEvent, id: string) => {
  if (event.altKey && tabs.value.length > 1) {
    showOnRight(id);
    return;
  }
  setActiveTab(id);
};

const setActiveTab = (id: string) => {
  activeTabId.value = id;

  // Restored tabs mount when they are first shown.
  const tab = tabs.value.find((t) => t.id === id);
  if (tab?.lazy) tab.lazy = false;

  if (!state.open) {
    state.open = true;
  }
};

const closeAndSetActiveTab = (id: string, force = false) => {
  const canClose = window.dispatchEvent(
    new CustomEvent<TabClosedEvent>("TabOrchestrator_TabClosed", {
      cancelable: true,
      detail: { id },
    })
  );

  if (!canClose && !force) {
    return;
  }

  const indexOfTab = tabs.value.findIndex((tab) => tab.id === id);
  closeTab(id);

  if (tabs.value.length > 0) {
    if (indexOfTab === 0) {
      setActiveTab(tabs.value[0].id);
    } else {
      setActiveTab(tabs.value[indexOfTab - 1].id);
    }
  }
};

/*
 * Hidden tabs stay mounted (v-show). Components that measure themselves
 * (terminals) re-fit on this event once their tab is visible again.
 */
watch(
  () => [activeTabId.value, splitTabId.value, state.open],
  () => {
    nextTick(() => window.dispatchEvent(new Event("TabOrchestrator_Resized")));
  }
);

const handleResize = (size: number) => {
  settings.value.PanelProvider.height = size;

  window.dispatchEvent(new Event("TabOrchestrator_Resized"));
};
</script>
<template>
  <ResizablePanel
    v-if="tabs.length > 0"
    :defaultSize="settings.PanelProvider.height"
    @resize="handleResize"
  >
    <div
      class="relative flex h-full flex-col bg-background"
      @keydown.stop="() => {}"
    >
      <div
        class="flex h-9 shrink-0 items-stretch border-b bg-surface-1 pr-1.5"
      >
        <div
          class="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Open tabs"
        >
          <div
            v-for="tab in tabs"
            :key="tab.id"
            class="group relative flex min-w-[120px] max-w-[220px] shrink-0 items-center border-r border-border-subtle text-xs transition-colors duration-fast"
            :class="
              activeTabId === tab.id
                ? '-mb-px bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-primary'
                : splitTabId === tab.id
                  ? '-mb-px bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-primary/40'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            "
            @mousedown.middle.prevent
            @auxclick.middle.prevent="closeAndSetActiveTab(tab.id)"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="activeTabId === tab.id"
              :title="tab.title"
              class="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              @click="onTabClick($event, tab.id)"
            >
              <tab-icon
                :name="tab.icon"
                :class="
                  activeTabId === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground'
                "
              />
              <span
                class="truncate"
                :class="{ 'font-medium': activeTabId === tab.id }"
                >{{ tab.title }}</span
              >
            </button>
            <button
              type="button"
              :aria-label="`Close ${tab.title}`"
              :title="`Close ${tab.title} (middle-click)`"
              class="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
              :class="{ 'opacity-60': activeTabId === tab.id }"
              @click.stop="closeAndSetActiveTab(tab.id)"
            >
              <X class="h-3 w-3" />
            </button>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1 pl-2">
          <span class="text-2xs tabular-nums text-muted-foreground/70">
            {{ tabs.length }} open
          </span>
          <Button
            v-if="tabs.length > 1"
            variant="ghost"
            size="icon-xs"
            :class="splitTabId ? 'text-primary' : 'text-muted-foreground'"
            :aria-pressed="!!splitTabId"
            aria-label="Split view"
            :title="
              splitTabId
                ? 'Close split view'
                : 'Split view (Alt+click a tab to show it on the right)'
            "
            @click="toggleSplit"
          >
            <Columns2 class="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            :aria-label="state.open ? 'Collapse panel' : 'Expand panel'"
            :title="state.open ? 'Collapse panel' : 'Expand panel'"
            :aria-expanded="state.open"
            @click="state.open = !state.open"
          >
            <ChevronDown
              class="h-3.5 w-3.5 transition-transform duration-base ease-out"
              :class="{ 'rotate-180': !state.open }"
            />
          </Button>
        </div>
      </div>
      <div
        class="relative flex min-h-0 flex-grow overflow-auto"
        v-show="state.open"
      >
        <!--
          Every tab is rendered and keyed by its id; inactive ones are only
          hidden. Closing a tab removes it from the list, which unmounts its
          component (stopping log follows, terminals, editors and listeners).
        -->
        <div
          v-for="tab in tabs"
          v-show="isVisible(tab.id)"
          :key="tab.id"
          role="tabpanel"
          :aria-label="tab.title"
          class="relative h-full min-w-0 flex-1 overflow-hidden"
          :class="
            splitTabId && tab.id === splitTabId
              ? 'order-2 border-l'
              : 'order-0'
          "
        >
          <div
            v-if="tab.lazy"
            class="flex h-full items-center justify-center text-xs text-muted-foreground"
          >
            Restoring {{ tab.title }}…
          </div>
          <component
            v-else
            :is="tab.component"
            v-bind="tab.props"
            :tabId="tab.id"
            @forceClose="closeAndSetActiveTab(tab.id, true)"
          />
        </div>
      </div>
    </div>
  </ResizablePanel>
</template>
