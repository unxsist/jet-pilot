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
    <div
      class="group cursor-pointer flex justify-between items-center ml-2 mb-2 uppercase font-bold text-xs text-[#7a7a7a]"
      @click="collapsed = !collapsed"
      v-if="title"
    >
      <span>{{ title }}</span>
      <div
        class="transition-all w-5 h-5 group-hover:bg-background rounded-full flex items-center justify-center mr-2"
        :class="{ 'rotate-180': !collapsed }"
      >
        <ArrowDownIcon class="w-5" />
      </div>
    </div>
    <div v-show="!collapsed" class="mb-5 space-y-1">
      <slot />
    </div>
  </div>
</template>
