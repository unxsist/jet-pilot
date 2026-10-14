<script setup lang="ts">
/**
 * Side panel sections of a Role or ClusterRole: its rules as a table, how
 * an aggregated ClusterRole collects them (and where this one adds its
 * own), and who it's granted to through which binding.
 */
import { Layers, ListChecks, Users } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import RulesTable from "./RulesTable.vue";
import ObjectLink from "./ObjectLink.vue";
import SubjectIcon from "./SubjectIcon.vue";
import { useRbacLinks } from "./useRbacLinks";
import { useRbacData } from "@/lib/accessReview";
import {
  aggregatedFrom,
  aggregatesInto,
  bindingScope,
  bindingsOfRole,
  indexRbac,
  normalizeSubject,
  type RoleObject,
} from "@/lib/rbac";

const props = defineProps<{ resource: RoleObject }>();
const { openObject, openSubject } = useRbacLinks();

const target = computed(() =>
  props.resource.metadata.context
    ? { context: props.resource.metadata.context, kubeConfig: props.resource.metadata.kubeConfig ?? "" }
    : null
);
const { data } = useRbacData(target);
const index = computed(() => (data.value ? indexRbac(data.value.snapshot) : null));
/* The listed copy (the panel's object may come from a watch, without our tags). */
const role = computed(
  () =>
    (props.resource.kind === "ClusterRole"
      ? index.value?.clusterRole(props.resource.metadata.name)
      : index.value?.role(props.resource.metadata.namespace ?? "", props.resource.metadata.name)) ?? props.resource
);

const rules = computed(() => props.resource.rules ?? []);
const selectors = computed(() => props.resource.aggregationRule?.clusterRoleSelectors ?? []);
const from = computed(() => (index.value ? aggregatedFrom(index.value, role.value) : []));
const into = computed(() => (index.value ? aggregatesInto(index.value, role.value) : []));
const bindings = computed(() => (index.value ? bindingsOfRole(index.value, role.value) : []));
const bindingsUnknown = computed(() =>
  (data.value?.unavailable ?? []).some((u) => u.kind === "RoleBinding" || u.kind === "ClusterRoleBinding")
);

const selectorLabels = (selector: { matchLabels?: Record<string, string> | null }) =>
  Object.entries(selector.matchLabels ?? {}).map(([key, value]) => {
    // Long label keys: the prefix on a line of its own, not broken mid-word.
    const slash = key.lastIndexOf("/");
    return { prefix: slash >= 0 ? key.slice(0, slash + 1) : "", rest: `${key.slice(slash + 1)}=${value}` };
  });
</script>

<template>
  <PanelSection value="rules" title="Rules" :icon="ListChecks" :count="rules.length">
    <p v-if="selectors.length" class="mb-2 text-xs text-muted-foreground">
      Aggregated: Kubernetes fills these rules in from other ClusterRoles (below).
    </p>
    <RulesTable :rules="rules" />
  </PanelSection>

  <PanelSection v-if="selectors.length || into.length" value="aggregation" title="Aggregation" :icon="Layers">
    <div class="space-y-3 text-sm">
      <div v-if="selectors.length" class="space-y-1.5">
        <p class="text-muted-foreground">Collects the rules of every ClusterRole labelled</p>
        <template v-for="(selector, i) in selectors" :key="i">
          <p v-for="label in selectorLabels(selector)" :key="label.rest" class="rounded-md bg-surface-1 px-2 py-1 break-all font-mono text-xs">
            <span v-if="label.prefix" class="block text-muted-foreground">{{ label.prefix }}</span>
            <span class="block">{{ label.rest }}</span>
          </p>
          <p v-if="!selectorLabels(selector).length" class="text-xs text-muted-foreground">(a label expression)</p>
        </template>
        <ul v-if="from.length" class="space-y-0.5 pt-1">
          <li v-for="other in from" :key="other.metadata.name" class="text-xs">
            <ObjectLink kind="ClusterRole" :name="other.metadata.name" :object="other" @open="openObject(other)" />
          </li>
        </ul>
        <p v-else-if="index" class="text-xs text-muted-foreground">No ClusterRole has that label right now.</p>
      </div>
      <div v-if="into.length" class="space-y-1">
        <p class="text-muted-foreground">Adds its rules to</p>
        <ul class="space-y-0.5">
          <li v-for="other in into" :key="other.metadata.name" class="text-xs">
            <ObjectLink kind="ClusterRole" :name="other.metadata.name" :object="other" @open="openObject(other)" />
          </li>
        </ul>
      </div>
    </div>
  </PanelSection>

  <PanelSection value="granted" title="Granted to" :icon="Users" :count="index ? bindings.length : undefined">
    <p v-if="!index" class="text-sm text-muted-foreground">Looking for bindings…</p>
    <p v-else-if="bindingsUnknown" class="text-sm text-muted-foreground">
      You can't list this cluster's bindings, so who has this role isn't known.
    </p>
    <p v-else-if="!bindings.length" class="text-sm text-muted-foreground">No binding grants this role: nobody has it.</p>
    <ul v-else class="space-y-3">
      <li v-for="binding in bindings" :key="binding.metadata.uid ?? binding.metadata.name" class="space-y-1.5">
        <p class="flex min-w-0 items-baseline justify-between gap-2 text-xs">
          <ObjectLink :kind="binding.kind" :name="binding.metadata.name" :object="binding" @open="openObject(binding)" />
          <span class="shrink-0 text-muted-foreground">{{ bindingScope(binding) === null ? "Everywhere" : `In ${bindingScope(binding)}` }}</span>
        </p>
        <ul class="space-y-1">
          <li v-for="raw in binding.subjects ?? []" :key="`${raw.kind}/${raw.namespace}/${raw.name}`">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-md text-left text-sm transition-colors duration-fast hover:text-link focus-ring"
              :title="`What can ${raw.name} do?`"
              @click="openSubject(normalizeSubject(raw, binding), binding.metadata.context)"
            >
              <SubjectIcon :kind="raw.kind" size="sm" />
              <span class="truncate">{{ raw.name }}</span>
              <span v-if="raw.kind === 'ServiceAccount'" class="truncate text-xs text-muted-foreground">
                {{ normalizeSubject(raw, binding).namespace }}
              </span>
            </button>
          </li>
          <li v-if="!binding.subjects?.length" class="text-xs text-muted-foreground">No subjects</li>
        </ul>
      </li>
    </ul>
  </PanelSection>
</template>
