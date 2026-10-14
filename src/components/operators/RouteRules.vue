<script setup lang="ts">
/**
 * The rules of an HTTPRoute / GRPCRoute as a calm flow: what matches,
 * what changes on the way (filters), and where it goes (backends, with
 * their share of the traffic). Backends open their Service.
 */
import { CornerDownRight } from "lucide-vue-next";
import ObjectLink from "./ObjectLink.vue";
import { routeRules } from "@/lib/operators/gatewayApi";
import { targetOf } from "@/lib/operators/panel";

const props = defineProps<{ route: any }>();

const rules = computed(() => routeRules(props.route));
const target = computed(() => targetOf(props.route));

/* Services are core; other backend kinds keep their own group. */
const backendRef = (backend: { kind: string; name: string; namespace?: string }) => ({
  apiVersion: "v1",
  kind: backend.kind,
  name: backend.name,
  namespace: backend.namespace,
});
</script>

<template>
  <p v-if="rules.length === 0" class="text-xs text-muted-foreground">No rules: this route doesn't send traffic anywhere.</p>
  <ol v-else class="space-y-2">
    <li
      v-for="(rule, index) in rules"
      :key="index"
      class="rounded-lg border border-border-subtle bg-surface-1/50 px-3 py-2.5 text-xs"
    >
      <ul class="space-y-1">
        <li v-for="(match, m) in rule.matches" :key="m" class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            v-if="match.method"
            class="rounded bg-muted px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground"
            >{{ match.method }}</span
          >
          <span class="font-medium text-foreground">{{ match.target }}</span>
          <span v-for="extra in match.extras" :key="extra" class="text-muted-foreground">· {{ extra }}</span>
        </li>
      </ul>
      <p v-for="filter in rule.filters" :key="filter" class="mt-1 text-muted-foreground">
        {{ filter }}
      </p>
      <ul class="mt-2 space-y-1">
        <li v-if="rule.backends.length === 0" class="flex items-center gap-1.5 text-muted-foreground">
          <CornerDownRight class="h-3.5 w-3.5 shrink-0" />
          No backend
        </li>
        <li v-for="backend in rule.backends" :key="backend.label" class="flex min-w-0 items-center gap-1.5">
          <CornerDownRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ObjectLink
            v-if="backend.kind === 'Service'"
            class="min-w-0"
            :target="target"
            :object="backendRef(backend)"
            :label="backend.label"
          />
          <span v-else class="truncate">{{ backend.label }} <span class="text-muted-foreground">({{ backend.kind }})</span></span>
          <template v-if="backend.percent !== undefined">
            <span class="ml-auto flex shrink-0 items-center gap-2 pl-2">
              <span class="relative h-1 w-14 overflow-hidden rounded-full bg-muted">
                <span
                  class="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                  :style="{ width: `${Math.max(backend.percent, 2)}%` }"
                />
              </span>
              <span class="w-8 text-right tabular-nums text-muted-foreground">{{ backend.percent }}%</span>
            </span>
          </template>
        </li>
      </ul>
    </li>
  </ol>
</template>
