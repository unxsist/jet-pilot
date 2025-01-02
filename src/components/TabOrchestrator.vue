<script setup lang="ts">
import {
  TabProviderStateKey,
  TabProviderCloseTabKey,
  TabClosedEvent,
} from "@/providers/TabProvider";
import { injectStrict } from "@/lib/utils";
import TabIcon from "@/components/TabIcon.vue";
import Expand from "@/assets/icons/expand.svg";
import Close from "@/assets/icons/close.svg";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

const { tabs, activeTabId } = injectStrict(TabProviderStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const closeTab = injectStrict(TabProviderCloseTabKey);

const state = reactive({
  open: true,
  resizing: false,
  resizeStartPositionY: 0,
  rerenderKey: 0,
});

const tabHeight = computed(() => {
  return settings.value.tabProvider.height >= 30
    ? settings.value.tabProvider.height
    : 30;
});

const activeTab = computed(() => {
  return tabs.value.find((tab) => tab.id === activeTabId.value);
});

const setActiveTab = (id: string) => {
  activeTabId.value = id;

  if (!state.open) {
    state.open = true;
  }
};

const onResizeStart = (e: MouseEvent) => {
  if (!state.open) {
    return;
  }

  state.resizing = true;
  state.resizeStartPositionY = e.clientY;

  window.addEventListener("mousemove", onResizing);
  window.addEventListener("mouseup", onResizeEnd);
};

const onResizing = (e: MouseEvent) => {
  if (!state.resizing) {
    return;
  }

  const delta = e.clientY - state.resizeStartPositionY;
  settings.value.tabProvider.height -= delta;
  state.resizeStartPositionY = e.clientY;

  window.dispatchEvent(new Event("TabOrchestrator_Resized"));
};

const onResizeEnd = () => {
  state.resizing = false;
  window.removeEventListener("mousemove", onResizing);
  window.removeEventListener("mouseup", onResizeEnd);
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
</script>
<template>
  <div
    @keydown.stop="() => {}"
    class="relative border-t border-l bg-background"
    v-if="tabs.length > 0"
  >
    <div
      class="absolute w-full h-2 border-t border-transparent"
      :class="{ 'hover:border-white cursor-ns-resize': state.open }"
      @mousedown="onResizeStart"
    ></div>
    <div class="flex items-center mb-0 text-xs py-1 px-1">
      <div class="flex space-x-3">
        <div
          class="group relative flex items-center py-1 px-2 rounded cursor-pointer max-w-[200px] truncate hover:bg-border"
          :class="{
            'bg-border': activeTabId === tab.id,
            'text-gray-400': activeTabId !== tab.id,
          }"
          v-for="tab in tabs"
          @click="setActiveTab(tab.id)"
          :title="tab.title"
        >
          <tab-icon :name="tab.icon" class="mr-1" />
          <span class="truncate">{{ tab.title }}</span>
          <div
            @click="closeAndSetActiveTab(tab.id)"
            class="hidden group-hover:block absolute right-1 p-0.5 rounded-sm bg-opacity-50 bg-accent hover:bg-accent text-foreground"
          >
            <Close class="h-3" />
          </div>
        </div>
      </div>
      <div
        class="ml-auto p-1 rounded cursor-pointer hover:bg-border"
        @click="state.open = !state.open"
      >
        <Expand
          class="text-white h-3"
          :class="{ 'rotate-90': !state.open, 'rotate-270': state.open }"
        />
      </div>
    </div>
    <div
      class="relative p-2"
      v-show="state.open"
      :style="{ height: `${tabHeight}px` }"
    >
      <keep-alive>
        <component
          :is="activeTab?.component"
          v-bind="activeTab?.props"
          :tabId="activeTab?.id"
          @forceClose="closeAndSetActiveTab(activeTab!.id, true)"
        />
      </keep-alive>
    </div>
  </div>
</template>
