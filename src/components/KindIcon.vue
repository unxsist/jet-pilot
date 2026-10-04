<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { kindIcon } from "@/lib/kindIcons";

/**
 * Icon for a Kubernetes kind / app surface (`pods`, `deployments`, `helm`,
 * `logs`, ...). Sized by the caller; defaults to 16px with a 1.75 stroke.
 */
const props = defineProps<{
  name: string;
  class?: HTMLAttributes["class"];
}>();

const icon = computed(() => kindIcon(props.name));
</script>

<template>
  <component
    :is="icon"
    :class="cn('h-4 w-4 shrink-0', props.class)"
    :stroke-width="1.75"
    aria-hidden="true"
  />
</template>
