<script setup lang="ts">
/**
 * The last lines a container wrote before it crashed (its previous
 * instance) or failed, fetched when this section opens. The full logs are
 * a click away.
 */
import { ScrollText } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchLogTail, type LogSource } from "@/lib/health/problems/evidence";
import type { Problem } from "@/lib/health/problems/model";

const props = defineProps<{ problem: Problem; source: LogSource }>();
const emit = defineEmits<{ open: [] }>();

const lines = shallowRef<string[] | null>(null);
const error = ref("");
const scroller = ref<HTMLElement | null>(null);

/* Lines that usually say what went wrong (a level or a verdict, not a file name like panic.go). */
const ALARM = /(^|[\s:=[])(error|fatal|panic|exception|killed|refused|denied)\b(?![./])/i;

onMounted(async () => {
  try {
    const text = await fetchLogTail(props.problem, props.source);
    lines.value = text.replace(/\s+$/, "").split("\n").filter((line, index, all) => line || index < all.length - 1);
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? String(e);
  }
});
</script>

<template>
  <div class="space-y-2">
    <div v-if="!lines && !error" class="space-y-1.5" aria-label="Fetching logs">
      <Skeleton v-for="index in 4" :key="index" class="h-3" :class="index % 2 ? 'w-full' : 'w-3/4'" />
    </div>
    <p v-else-if="error" class="text-xs text-muted-foreground">Couldn't fetch the logs: {{ error }}</p>
    <p v-else-if="!lines?.length" class="text-xs text-muted-foreground">It didn't write any logs.</p>
    <div
      v-else
      ref="scroller"
      class="max-h-72 overflow-auto rounded-lg border bg-surface-1 px-3 py-2 font-mono text-2xs leading-relaxed text-muted-foreground"
    >
      <p
        v-for="(line, index) in lines"
        :key="index"
        class="select-text whitespace-pre-wrap break-words"
        :class="ALARM.test(line) && 'text-destructive'"
      >{{ line || " " }}</p>
    </div>
    <Button variant="ghost" size="sm" class="-ml-2 text-muted-foreground" @click="emit('open')">
      <ScrollText class="h-3.5 w-3.5" />
      Open all logs
    </Button>
  </div>
</template>
