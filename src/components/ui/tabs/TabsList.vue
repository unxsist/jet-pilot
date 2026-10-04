<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { TabsList, type TabsListProps } from "radix-vue";
import { cn } from "@/lib/utils";

/**
 * variant="segmented" (default): pill-style segmented control.
 * variant="line": underline tabs for page / panel sections.
 */
const props = withDefaults(
  defineProps<
    TabsListProps & {
      variant?: "segmented" | "line";
      class?: HTMLAttributes["class"];
    }
  >(),
  {
    variant: "segmented",
  }
);

const delegatedProps = computed(() => {
  const { class: _, variant: __, ...delegated } = props;

  return delegated;
});
</script>

<template>
  <TabsList
    v-bind="delegatedProps"
    :data-variant="props.variant"
    :class="
      cn(
        'group/tabs inline-flex items-center text-muted-foreground',
        props.variant === 'line'
          ? 'h-9 gap-4 border-b border-border'
          : 'h-8 gap-0.5 rounded-lg bg-muted p-0.5',
        props.class
      )
    "
  >
    <slot />
  </TabsList>
</template>
