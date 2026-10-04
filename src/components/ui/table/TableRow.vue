<script setup lang="ts">
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: string }>();
</script>

<template>
  <tr
    :class="
      cn(
        'border-b border-border-subtle transition-colors duration-75 hover:bg-muted/60 data-[state=selected]:bg-primary/10 data-[state=selected]:hover:bg-primary/[0.14]',
        props.class
      )
    "
  >
    <slot />
  </tr>
</template>
