<script setup lang="ts">
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { formatAge, toDate } from "@/components/tables/age";
import { formatDateTime } from "@/lib/utils";

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: unknown;
}

defineProps<{ conditions: Condition[] }>();

/* Conditions where "True" is bad news (node pressure, ...). */
const INVERTED = /(Pressure|Unavailable|Failed|Degraded)$/;

const toneOf = (condition: Condition): StatusTone => {
  const healthy = INVERTED.test(condition.type)
    ? condition.status === "False"
    : condition.status === "True";

  if (condition.status !== "True" && condition.status !== "False") {
    return "muted";
  }
  return healthy ? "success" : "warning";
};

const transitionTitle = (value: unknown) => {
  const date = toDate(value);
  return date ? formatDateTime(date) : undefined;
};
</script>

<template>
  <ul class="divide-y divide-border-subtle">
    <li
      v-for="condition in conditions"
      :key="condition.type"
      class="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0"
    >
      <StatusDot
        :tone="toneOf(condition)"
        :label="`${condition.type}: ${condition.status}`"
        class="mt-1.5"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate text-sm font-medium">{{ condition.type }}</span>
          <span
            v-if="condition.lastTransitionTime"
            class="shrink-0 text-xs tabular-nums text-muted-foreground"
            :title="transitionTitle(condition.lastTransitionTime)"
            >{{ formatAge(condition.lastTransitionTime) }}</span
          >
        </div>
        <p
          v-if="condition.reason || condition.message"
          class="text-xs text-muted-foreground select-text"
        >
          <span v-if="condition.reason" class="font-medium text-foreground/80">{{
            condition.reason
          }}</span>
          <template v-if="condition.reason && condition.message">
            ·
          </template>
          {{ condition.message }}
        </p>
      </div>
    </li>
  </ul>
</template>
