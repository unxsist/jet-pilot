<script setup lang="ts">
import {
  TabProviderStateKey,
  TabProviderCloseTabKey,
} from "@/providers/TabProvider";
import { injectStrict } from "@/lib/utils";
import Expand from "@/assets/icons/expand.svg";
import Close from "@/assets/icons/close.svg";

const { tabs, activeTabId } = injectStrict(TabProviderStateKey);
const closeTab = injectStrict(TabProviderCloseTabKey);

const state = reactive({
  open: true,
});

const activeTab = computed(() => {
  return tabs.value.find((tab) => tab.id === activeTabId.value);
});
</script>
<template>
  <div class="border-t border-l bg-background" v-if="tabs.length > 0">
    <div class="flex items-center mb-0 text-xs py-1 px-1">
      <div class="flex space-x-3">
        <div
          class="group relative flex items-center py-1 px-2 rounded cursor-pointer max-w-[200px] truncate hover:bg-border"
          :class="{
            'bg-border': activeTabId === tab.id,
            'text-gray-400': activeTabId !== tab.id,
          }"
          v-for="tab in tabs"
          @click="activeTabId = tab.id"
        >
          <span class="truncate">{{ tab.title }}</span>
          <div
            @click="closeTab(tab.id)"
            class="hidden group-hover:block absolute right-1 p-0.5 rounded-sm bg-opacity-50 bg-white hover:bg-white text-background"
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
    <div class="p-2" v-show="state.open">
      <keep-alive>
        <component :is="activeTab?.component" v-bind="activeTab?.props" />
      </keep-alive>
    </div>
  </div>
</template>
