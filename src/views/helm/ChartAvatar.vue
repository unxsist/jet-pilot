<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { artifactHubLogo } from "@/lib/helmApi";

/*
 * A chart's mark: its Artifact Hub logo (fetched and cached by the
 * backend, never loaded remotely by the webview) or, without one, its
 * initial on a hue derived from the name, like cluster monograms.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    logoImageId?: string | null;
    size?: "sm" | "default" | "lg";
    class?: HTMLAttributes["class"];
  }>(),
  { logoImageId: null, size: "default", class: undefined }
);

const logo = ref<string | null>(null);
watch(
  () => props.logoImageId,
  async (id) => {
    logo.value = null;
    if (!id) return;
    const url = await artifactHubLogo(id);
    if (id === props.logoImageId) logo.value = url;
  },
  { immediate: true }
);

const hue = computed(() => {
  let hash = 0;
  for (const char of props.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
});

const initial = computed(() => (props.name.replace(/[^a-z0-9]/gi, "")[0] ?? "?").toUpperCase());

const sizeClass = computed(() =>
  props.size === "sm" ? "h-6 w-6 text-2xs rounded-md" : props.size === "lg" ? "h-11 w-11 text-base rounded-xl" : "h-9 w-9 text-sm rounded-lg"
);
</script>

<template>
  <span
    v-if="logo"
    :class="cn('inline-flex shrink-0 items-center justify-center overflow-hidden bg-card p-1 ring-1 ring-inset ring-border-subtle dark:bg-foreground/90', sizeClass, props.class)"
    aria-hidden="true"
  >
    <img :src="logo" alt="" class="h-full w-full object-contain" draggable="false" />
  </span>
  <span
    v-else
    :class="
      cn(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none',
        'bg-[hsl(var(--avatar-h)_70%_50%/0.14)] text-[hsl(var(--avatar-h)_60%_34%)] ring-1 ring-inset ring-[hsl(var(--avatar-h)_60%_50%/0.18)]',
        'dark:bg-[hsl(var(--avatar-h)_70%_60%/0.14)] dark:text-[hsl(var(--avatar-h)_80%_76%)]',
        sizeClass,
        props.class
      )
    "
    :style="{ '--avatar-h': hue }"
    aria-hidden="true"
  >
    {{ initial }}
  </span>
</template>
