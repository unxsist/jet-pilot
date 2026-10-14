<script setup lang="ts">
/**
 * The top of an operator object's side panel: the state in words, one
 * quiet line under it, what the controller said when something is wrong
 * (long messages folded) and the object's actions.
 */
import { StatusDot, statusTextClass, type StatusTone } from "@/components/ui/status";
import type { OperatorState } from "@/lib/operators/format";

const props = defineProps<{
  state: OperatorState;
  /** One quiet line: "Expires in 23 days · renews in 2 days". */
  line?: string;
  /** Colours the line (e.g. near expiry). */
  lineTone?: StatusTone;
  /** The problem in plain words, above the controller's own message. */
  hint?: string;
}>();

const problem = computed(
  () => props.state.tone === "destructive" || props.state.tone === "warning"
);

const LONG = 220;
const expanded = ref(false);
const message = computed(() => (problem.value ? props.state.message ?? "" : ""));
const long = computed(() => message.value.length > LONG || message.value.split("\n").length > 4);
watch(message, () => (expanded.value = false));

const boxClass = computed(() =>
  props.state.tone === "destructive"
    ? "border-destructive/20 bg-destructive/5"
    : "border-warning/20 bg-warning/5"
);
</script>

<template>
  <div class="space-y-3 border-b px-4 pb-4 pt-3.5">
    <div class="space-y-1">
      <div class="flex items-center gap-2.5">
        <StatusDot :tone="state.tone" :pulse="state.busy" />
        <span
          class="text-base font-semibold"
          :class="problem ? statusTextClass[state.tone] : 'text-foreground'"
          :title="state.reason"
          >{{ state.label }}</span
        >
      </div>
      <p
        v-if="line"
        class="pl-[18px] text-xs"
        :class="lineTone && lineTone !== 'muted' ? statusTextClass[lineTone] : 'text-muted-foreground'"
      >
        {{ line }}
      </p>
    </div>

    <div
      v-if="message || (problem && hint)"
      class="rounded-lg border px-3 py-2 text-xs leading-relaxed text-foreground"
      :class="boxClass"
    >
      <p v-if="hint" class="font-medium">{{ hint }}</p>
      <p
        v-if="message"
        class="select-text whitespace-pre-wrap break-words"
        :class="[!expanded && long ? 'line-clamp-4' : '', hint ? 'mt-0.5 text-muted-foreground' : '']"
      >
        {{ message }}
      </p>
      <button
        v-if="long"
        type="button"
        class="mt-1 font-medium text-link hover:underline"
        @click="expanded = !expanded"
      >
        {{ expanded ? "Show less" : "Show all" }}
      </button>
    </div>

    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-1.5">
      <slot name="actions" />
    </div>
  </div>
</template>
