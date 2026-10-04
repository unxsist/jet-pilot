<script setup lang="ts">
import { ref } from "vue";
import ArrowDownIcon from "@/assets/icons/arrow_down.svg";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const props = defineProps<{ title: string }>();

const { settings } = injectStrict(SettingsContextStateKey);
const collapsed = ref(
  settings.value.collapsedNavigationGroups.includes(props.title)
);

watch(
  () => collapsed.value,
  (collapsed) => {
    if (collapsed) {
      settings.value.collapsedNavigationGroups.push(props.title);
    } else {
      settings.value.collapsedNavigationGroups =
        settings.value.collapsedNavigationGroups.filter(
          (title) => title !== props.title
        );
    }
  }
);
</script>
<template>
  <div>
    <button
      v-if="title"
      type="button"
      class="group w-[calc(100%-0.5rem)] cursor-pointer flex justify-between items-center ml-2 mb-2 rounded uppercase font-bold text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="truncate">{{ title }}</span>
      <div
        class="transition-all w-5 h-5 group-hover:bg-background rounded-full flex items-center justify-center mr-2"
        :class="{ 'rotate-180': !collapsed }"
      >
        <ArrowDownIcon class="w-5" />
      </div>
    </button>
    <div v-show="!collapsed" class="mb-5 space-y-1">
      <slot />
    </div>
  </div>
</template>
