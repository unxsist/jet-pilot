<script setup lang="ts">
import { Skeleton } from "@/components/ui/skeleton";
import NavigationSkeleton from "./NavigationSkeleton.vue";

/*
 * The app shell while settings (and with them the active contexts) load.
 * Mirrors the real layout (sidebar + inset canvas with a table) so nothing
 * jumps when the app replaces it. index.html contains a static copy of
 * this layout that is visible before any JavaScript ran.
 */
const COLUMN_WIDTHS = ["34%", "14%", "10%", "12%", "8%"];
</script>
<template>
  <div
    class="flex min-h-0 w-full flex-1"
    role="status"
    aria-label="Loading JET Pilot"
    data-app-skeleton
  >
    <div
      class="flex w-[224px] min-w-[224px] shrink-0 flex-col"
      data-tauri-drag-region
    >
      <div class="h-10 shrink-0" data-tauri-drag-region></div>
      <div class="space-y-1.5 px-2 pb-3">
        <div
          class="flex items-center gap-2.5 rounded-lg border bg-background/60 p-1.5 shadow-xs"
        >
          <Skeleton class="h-8 w-8 shrink-0" />
          <div class="flex-1 space-y-1.5">
            <Skeleton class="h-3 w-3/4 rounded-sm" />
            <Skeleton class="h-2.5 w-1/2 rounded-sm" />
          </div>
        </div>
        <div class="h-8 rounded-md border bg-background/60 shadow-xs"></div>
      </div>
      <NavigationSkeleton />
    </div>
    <div class="flex min-w-0 flex-1 py-1.5 pr-1.5" data-tauri-drag-region>
      <div
        class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background shadow-xs"
      >
        <div class="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <Skeleton class="h-7 w-64" />
          <div class="flex-1"></div>
          <Skeleton class="h-7 w-20" />
        </div>
        <div class="flex h-9 shrink-0 items-center gap-6 border-b px-4">
          <Skeleton
            v-for="(width, i) in COLUMN_WIDTHS"
            :key="i"
            class="h-2.5 rounded-sm"
            :style="{ width }"
          />
        </div>
        <div
          v-for="row in 12"
          :key="row"
          class="flex h-9 shrink-0 items-center gap-6 border-b border-border-subtle px-4"
          :style="{ opacity: 1 - row * 0.06 }"
        >
          <Skeleton
            v-for="(width, i) in COLUMN_WIDTHS"
            :key="i"
            class="h-3 rounded-sm"
            :style="{ width }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
