<script setup lang="ts">
/** "Managed by Argo CD app shop. A change here is reverted on the next sync; fix it in Git." */
import { GitMerge } from "lucide-vue-next";
import { managedWords, type Manager } from "@/lib/health/problems/managed";

const props = defineProps<{ manager: Manager }>();
const words = computed(() => managedWords(props.manager));
</script>

<template>
  <div class="flex gap-2.5 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5 text-xs">
    <GitMerge class="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
    <div class="space-y-0.5">
      <p class="font-medium text-foreground">{{ words.title }}</p>
      <p class="text-muted-foreground">{{ words.detail }}</p>
    </div>
  </div>
</template>
