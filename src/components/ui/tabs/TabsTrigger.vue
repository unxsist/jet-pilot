<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { TabsTrigger, type TabsTriggerProps, useForwardProps } from "radix-vue";
import { cn } from "@/lib/utils";

const props = defineProps<
  TabsTriggerProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props;

  return delegated;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <TabsTrigger
    v-bind="forwarded"
    :class="
      cn(
        'relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium',
        'transition-[color,background-color,box-shadow] duration-fast ease-out',
        'hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        // segmented
        'h-7 rounded-md px-2.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-accent',
        // line
        'group-data-[variant=line]/tabs:h-full group-data-[variant=line]/tabs:rounded-none group-data-[variant=line]/tabs:px-0.5 group-data-[variant=line]/tabs:data-[state=active]:bg-transparent group-data-[variant=line]/tabs:data-[state=active]:shadow-none dark:group-data-[variant=line]/tabs:data-[state=active]:bg-transparent',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity group-data-[variant=line]/tabs:data-[state=active]:after:opacity-100',
        props.class
      )
    "
  >
    <slot />
  </TabsTrigger>
</template>
