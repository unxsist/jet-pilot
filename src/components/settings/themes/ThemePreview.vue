<script setup lang="ts">
/*
 * A miniature of the app painted with a theme's own tokens: the token
 * triplets are set as inline custom properties on the root and the
 * `.dark` / `.light` class scopes the aliases (card, popover, sidebar), so
 * the same token classes as the app render the theme. Fixed height: the
 * skeleton and the preview take the same space (no layout shift).
 */
import { varsStyle } from "./shared";
import type { ThemeAppearance, ThemeToken } from "@/lib/themes/types";

const props = defineProps<{
  vars: Record<ThemeToken, string> | null;
  appearance: ThemeAppearance;
}>();

const style = computed(() => varsStyle(props.vars));

const rows = [
  { dot: "bg-success", name: "w-12", meta: "w-4" },
  { dot: "bg-warning", name: "w-9", meta: "w-5" },
  { dot: "bg-success", name: "w-14", meta: "w-3" },
  { dot: "bg-destructive", name: "w-10", meta: "w-4" },
];
</script>

<template>
  <div
    v-if="!vars"
    class="h-28 animate-pulse rounded-md border bg-muted"
    aria-hidden="true"
  ></div>
  <div
    v-else
    :class="appearance"
    :style="style"
    class="flex h-28 overflow-hidden rounded-md border bg-sidebar"
    aria-hidden="true"
  >
    <!-- Navigation: brand, the active item (accent row + primary indicator), items -->
    <div class="flex w-[30%] shrink-0 flex-col gap-1 py-2 pl-2 pr-1.5">
      <div class="mb-1 flex items-center gap-1">
        <span class="h-2 w-2 rounded-sm bg-primary"></span>
        <span class="h-1 w-7 rounded-full bg-sidebar-foreground/60"></span>
      </div>
      <div class="relative flex items-center gap-1 rounded-sm bg-accent px-1 py-[3px]">
        <span class="absolute -left-1.5 bottom-0.5 top-0.5 w-0.5 rounded-full bg-primary"></span>
        <span class="h-1.5 w-1.5 rounded-[2px] bg-primary"></span>
        <span class="h-1 w-7 rounded-full bg-accent-foreground/70"></span>
      </div>
      <div
        v-for="width in ['w-6', 'w-8', 'w-5']"
        :key="width"
        class="flex items-center gap-1 px-1 py-[3px]"
      >
        <span class="h-1.5 w-1.5 rounded-[2px] bg-muted-foreground/50"></span>
        <span :class="width" class="h-1 rounded-full bg-sidebar-foreground/35"></span>
      </div>
    </div>
    <!-- Content: toolbar with the primary action, a table with status dots -->
    <div class="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] border bg-background">
      <div class="flex items-center gap-1 border-b px-1.5 py-1">
        <span class="h-1.5 w-9 rounded-full bg-foreground/75"></span>
        <span class="h-1 w-5 rounded-full bg-link"></span>
        <span class="ml-auto h-2.5 w-7 rounded-[3px] bg-primary"></span>
      </div>
      <div
        v-for="(row, index) in rows"
        :key="index"
        class="flex items-center gap-1.5 border-b border-border-subtle px-1.5 py-[3px] last:border-b-0"
        :class="index === 1 ? 'bg-accent/60' : ''"
      >
        <span :class="row.dot" class="h-1.5 w-1.5 shrink-0 rounded-full"></span>
        <span :class="row.name" class="h-1 rounded-full bg-foreground/55"></span>
        <span :class="row.meta" class="ml-auto h-1 rounded-full bg-muted-foreground/45"></span>
      </div>
    </div>
  </div>
</template>
