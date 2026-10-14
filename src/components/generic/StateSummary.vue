<script setup lang="ts">
/**
 * The top of a side panel: the object's state in a word, since when, and
 * (for problems) what is wrong in a sentence. Healthy states stay a quiet
 * line. `#actions` holds the kind's primary actions (Cordon, Trigger now).
 */
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { formatDateTime } from "@/lib/utils";
import { durationWords, toMs } from "@/lib/resources/format";
import type { ObjectState } from "@/lib/resources/state";

const props = defineProps<{ state: ObjectState | null; now: number }>();

const problem = computed(() => props.state?.tone === "warning" || props.state?.tone === "destructive");

const since = computed(() => {
  const at = toMs(props.state?.since);
  if (at === null || at > props.now) return null;
  return { text: `for ${durationWords(props.now - at)}`, title: formatDateTime(new Date(at)) };
});

/* Long messages (scheduler, controllers) fold. */
const LONG = 240;
const expanded = ref(false);
const long = computed(() => (props.state?.detail?.length ?? 0) > LONG);
watch(() => props.state?.detail, () => (expanded.value = false));
</script>

<template>
  <div v-if="state || $slots.actions" class="space-y-2.5 border-b px-4 pb-3.5 pt-3">
    <div v-if="state" class="flex items-center gap-2.5">
      <StatusDot :tone="state.tone" :pulse="state.tone === 'info'" />
      <span
        class="text-sm font-semibold"
        :class="problem ? statusTextClass[state.tone] : 'text-foreground'"
        >{{ state.label }}</span
      >
      <span v-if="since" class="text-xs tabular-nums text-muted-foreground" :title="since.title">{{ since.text }}</span>
    </div>
    <div
      v-if="state?.detail"
      class="text-xs leading-relaxed"
      :class="
        problem
          ? state.tone === 'destructive'
            ? 'rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-foreground'
            : 'rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-foreground'
          : '-mt-1 pl-[18px] text-muted-foreground'
      "
    >
      <p class="select-text whitespace-pre-wrap break-words" :class="!expanded && long ? 'line-clamp-3' : ''">
        {{ state.detail }}
      </p>
      <button v-if="long" type="button" class="mt-1 font-medium text-link hover:underline" @click="expanded = !expanded">
        {{ expanded ? "Show less" : "Show all" }}
      </button>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-1.5">
      <slot name="actions" />
    </div>
  </div>
</template>
