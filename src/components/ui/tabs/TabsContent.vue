<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { TabsContent, type TabsContentProps } from "radix-vue";
import { cn } from "@/lib/utils";

const props = defineProps<
  TabsContentProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props;

  return delegated;
});
</script>

<template>
  <TabsContent
    v-bind="delegatedProps"
    :class="
      cn(
        'mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        props.class
      )
    "
  >
    <slot />
  </TabsContent>
</template>
