<script setup lang="ts">
/* "Checked 2m ago · Check again": when an on-demand check last ran. */
import { useIntervalFn } from "@vueuse/core";
import { Loader2 } from "lucide-vue-next";
import { relativeTime } from "@/lib/clusters/status";
import { formatDateTime } from "@/lib/utils";

const props = defineProps<{ at: number | null; running: boolean }>();
const emit = defineEmits<{ again: [] }>();

const now = ref(Date.now());
useIntervalFn(() => (now.value = Date.now()), 30_000);
const checked = computed(() => (props.at ? `Checked ${relativeTime(props.at, now.value)}` : ""));
</script>

<template>
  <p class="flex h-5 items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
    <template v-if="running">
      <Loader2 class="h-3 w-3 animate-spin" />
      Checking…
    </template>
    <template v-else-if="at">
      <span :title="formatDateTime(new Date(at))">{{ checked }}</span>
      <span aria-hidden="true" class="text-muted-foreground/60">·</span>
      <button type="button" class="rounded text-link hover:underline focus-ring" @click="emit('again')">Check again</button>
    </template>
  </p>
</template>
