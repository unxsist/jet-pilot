<script setup lang="ts">
import {
  PanelProviderStateKey,
  PanelProviderCloseTabKey,
  TabClosedEvent,
} from "@/providers/PanelProvider";
import { injectStrict } from "@/lib/utils";
import TabIcon from "@/components/TabIcon.vue";
import { ChevronDown, X } from "lucide-vue-next";
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
              @click="setActiveTab(tab.id)"
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
      <div class="relative min-h-0 flex-grow overflow-auto" v-show="state.open">
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
          class="h-full w-full"
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
