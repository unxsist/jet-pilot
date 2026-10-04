<script setup lang="ts">
import type { ComboboxItemEmits, ComboboxItemProps } from "radix-vue";
import { ComboboxItem, useEmitAsProps } from "radix-vue";
import { cn } from "@/lib/utils";

const props = defineProps<ComboboxItemProps>();
const emits = defineEmits<ComboboxItemEmits>();

const emitsAsProps = useEmitAsProps(emits);
</script>

<template>
  <ComboboxItem
    v-bind="{ ...props, ...emitsAsProps }"
    :class="
      cn(
        'relative flex min-h-[2.25rem] cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors duration-75 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        // accent rail on the highlighted row
        'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity data-[highlighted]:before:opacity-100',
        '[&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        $attrs.class ?? ''
      )
    "
  >
    <slot />
  </ComboboxItem>
</template>
