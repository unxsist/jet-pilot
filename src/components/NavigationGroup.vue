<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

/*
 * A collapsible section of the navigation. The title is also the key of
 * the persisted collapsed state; it is shown in sentence case.
 */
const props = defineProps<{ title: string }>();
const label = computed(
  () => props.title.charAt(0) + props.title.slice(1).toLowerCase()
);

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
  <div class="mb-4 last:mb-0">
    <button
      v-if="title"
      type="button"
      class="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring focus-visible:ring-offset-sidebar"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="truncate">{{ label }}</span>
      <ChevronDown
        class="h-3 w-3 shrink-0 opacity-0 transition-[transform,opacity] duration-base ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
        :class="{ '-rotate-90 opacity-100': collapsed }"
        aria-hidden="true"
      />
    </button>
    <div v-show="!collapsed" class="space-y-px">
      <slot />
    </div>
  </div>
</template>
