<script setup lang="ts">
import { ToastViewport, type ToastViewportProps } from "radix-vue";
import { cn } from "@/lib/utils";

const props = defineProps<ToastViewportProps & { class?: string }>();
</script>

<template>
  <ToastViewport
    v-bind="props"
    :class="
      cn(
        'fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 outline-none sm:max-w-[380px]',
        props.class
      )
    "
  />
</template>
