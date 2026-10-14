<script setup lang="ts">
/**
 * A role's rules as a readable list, one short sentence each: what it may
 * do ("Read and change", "Every verb on") and what to, with the API group,
 * names-only grants and rarer verbs in a quiet line underneath. Long lists
 * show their first rules.
 */
import { StatusBadge } from "@/components/ui/status";
import {
  MATRIX_VERBS,
  groupLabel,
  isFullAccess,
  isNonResourceRule,
  joinWords,
  ruleSummary,
  verbPhrase,
  type PolicyRule,
} from "@/lib/rbac";

const props = defineProps<{ rules: PolicyRule[] }>();

const MAX_RESOURCES = 4;
const MAX_RULES = 6;
const showAll = ref(false);

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const everyday = (verb: string) => (MATRIX_VERBS as readonly string[]).includes(verb);

function describe(rule: PolicyRule) {
  const verbs = rule.verbs ?? [];
  const rare = verbs.filter((v) => v !== "*" && !everyday(v));
  const main = verbs.filter(everyday);
  const verb = verbs.includes("*")
    ? "Every verb on"
    : main.length
      ? capital(verbPhrase(main))
      : capital(joinWords(rare));
  const notes: string[] = [];
  let targets: string[];
  let more = 0;
  if (isNonResourceRule(rule)) {
    const urls = rule.nonResourceURLs ?? [];
    targets = urls.includes("*") ? ["every URL path"] : urls;
    notes.push("URL paths, not resources");
  } else {
    const resources = (rule.resources ?? []).map((r) => (r === "*" ? "every resource" : r));
    targets = resources.slice(0, MAX_RESOURCES);
    more = Math.max(0, resources.length - MAX_RESOURCES);
    notes.push(joinWords((rule.apiGroups ?? []).map(groupLabel)));
    if (rule.resourceNames?.length) notes.push(`only ${joinWords(rule.resourceNames)}`);
  }
  if (main.length && rare.length) notes.push(`also ${joinWords(rare)}`);
  return { verb, targets, more, notes: notes.filter(Boolean).join(" · "), mono: isNonResourceRule(rule) };
}

const rows = computed(() =>
  (showAll.value ? props.rules : props.rules.slice(0, MAX_RULES)).map((rule) => ({ rule, ...describe(rule) }))
);
</script>

<template>
  <p v-if="!rules.length" class="text-sm text-muted-foreground">No rules: this role grants nothing.</p>
  <div v-else class="space-y-2">
    <ul class="divide-y divide-border-subtle overflow-hidden rounded-lg border">
      <li v-for="(row, index) in rows" :key="index" class="space-y-0.5 px-3 py-2" :title="capital(ruleSummary(row.rule))">
        <p class="break-words text-sm leading-5">
          <StatusBadge v-if="isFullAccess(row.rule)" tone="warning" :dot="false" class="mr-1.5 align-middle">Full access</StatusBadge>
          <span class="font-medium">{{ row.verb }}</span>
          {{ " " }}
          <span :class="row.mono && 'font-mono text-xs'">{{ row.targets.join(", ") }}</span>
          <span v-if="row.more" class="text-muted-foreground" :title="(row.rule.resources ?? []).join(', ')"> and {{ row.more }} more</span>
        </p>
        <p class="truncate text-xs text-muted-foreground" :title="row.notes">{{ row.notes }}</p>
      </li>
    </ul>
    <button
      v-if="rules.length > MAX_RULES"
      type="button"
      class="rounded px-1 text-xs font-medium text-link hover:underline focus-ring"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show fewer" : `Show ${rules.length - MAX_RULES} more rules` }}
    </button>
  </div>
</template>
