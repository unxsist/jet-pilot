<script setup lang="ts">
import {
  PanelProviderStateKey,
  PanelProviderCloseTabKey,
  TabClosedEvent,
} from "@/providers/PanelProvider";
import { injectStrict } from "@/lib/utils";
import TabIcon from "@/components/TabIcon.vue";
import Expand from "@/assets/icons/expand.svg";
import Close from "@/assets/icons/close.svg";
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

const setActiveTab = (id: string) => {
  activeTabId.value = id;

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
  () => [activeTabId.value, state.open],
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
      class="flex h-full flex-col relative border-t border-l bg-background"
      @keydown.stop="() => {}"
    >
      <div class="flex items-center mb-0 text-xs py-1 px-1">
        <div
          class="flex space-x-3 overflow-x-auto"
          role="tablist"
          aria-label="Open tabs"
        >
          <div
            v-for="tab in tabs"
            :key="tab.id"
            class="group relative flex items-center rounded max-w-[200px] hover:bg-border"
            :class="{
              'bg-border': activeTabId === tab.id,
              'text-muted-foreground': activeTabId !== tab.id,
            }"
            @mousedown.middle.prevent
            @auxclick.middle.prevent="closeAndSetActiveTab(tab.id)"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="activeTabId === tab.id"
              :title="tab.title"
              class="flex items-center min-w-0 py-1 pl-2 pr-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @click="setActiveTab(tab.id)"
            >
              <tab-icon :name="tab.icon" class="mr-1 shrink-0" />
              <span class="truncate">{{ tab.title }}</span>
            </button>
            <button
              type="button"
              :aria-label="`Close ${tab.title}`"
              :title="`Close ${tab.title} (middle-click)`"
              class="absolute right-1 p-0.5 rounded-sm text-foreground hover:bg-accent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @click.stop="closeAndSetActiveTab(tab.id)"
            >
              <Close class="h-3" />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="ml-auto p-1 rounded hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="state.open ? 'Collapse panel' : 'Expand panel'"
          :title="state.open ? 'Collapse panel' : 'Expand panel'"
          :aria-expanded="state.open"
          @click="state.open = !state.open"
        >
          <Expand
            class="text-foreground h-3"
            :class="{ 'rotate-90': !state.open, 'rotate-270': state.open }"
          />
        </button>
      </div>
      <div class="relative flex-grow p-2 overflow-auto" v-show="state.open">
        <!--
          Every tab is rendered and keyed by its id; inactive ones are only
          hidden. Closing a tab removes it from the list, which unmounts its
          component (stopping log follows, terminals, editors and listeners).
        -->
        <div
          v-for="tab in tabs"
          v-show="tab.id === activeTabId"
          :key="tab.id"
          role="tabpanel"
          class="w-full h-full"
        >
          <component
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
