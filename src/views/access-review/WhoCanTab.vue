<script setup lang="ts">
/*
 * Who can …? Worked out from every Role, ClusterRole and binding: each
 * subject that may do it, where, and why (binding › role › rule).
 * Built-in subjects (controllers, nodes, system groups) are hidden until
 * asked for: they're rarely the answer people look for.
 */
import { ChevronRight, Loader2, UserX } from "lucide-vue-next";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import QuestionSentence from "@/components/rbac/QuestionSentence.vue";
import GrantChain from "@/components/rbac/GrantChain.vue";
import SubjectIcon from "@/components/rbac/SubjectIcon.vue";
import RbacNotice from "@/components/rbac/RbacNotice.vue";
import DanglingBindings from "@/components/rbac/DanglingBindings.vue";
import { useRbacLinks } from "@/components/rbac/useRbacLinks";
import {
  EVERY_NAMESPACE,
  URL_RESOURCE,
  isNamespaced,
  parseResourceValue,
  questionText,
  requestOf,
  type Question,
} from "@/components/rbac/question";
import {
  danglingBindings,
  indexRbac,
  subjectHint,
  whoCan,
  wildcardSummary,
  type Scope,
  type SubjectAccess,
} from "@/lib/rbac";
import { StatusBadge } from "@/components/ui/status";
import type { RbacData } from "@/lib/accessReview";
import type { DiscoveredResource, DiscoverySnapshot } from "@/lib/discovery";

const props = defineProps<{
  resources: DiscoveredResource[];
  discovery: DiscoverySnapshot | null;
  namespaces: string[];
  rbac: RbacData | null;
  loading: boolean;
}>();
const question = defineModel<Question>("question", { required: true });
const emit = defineEmits<{ askMe: []; retry: [] }>();
const { openSubject } = useRbacLinks();

const namespaced = computed(() => {
  if (question.value.resource === URL_RESOURCE) return false;
  const { resource, group } = parseResourceValue(question.value.resource);
  return isNamespaced(props.resources, resource, group);
});

/* Cluster-scoped resources and URLs: only ClusterRoleBindings grant them. */
const scope = computed<Scope>(() => {
  if (!namespaced.value) return "cluster";
  return question.value.namespace === EVERY_NAMESPACE ? "anywhere" : { namespace: question.value.namespace };
});

const index = computed(() => (props.rbac ? indexRbac(props.rbac.snapshot) : null));
const unavailable = computed(() => props.rbac?.unavailable ?? []);
const request = computed(() => requestOf(question.value, namespaced.value));
const results = computed(() => (index.value ? whoCan(index.value, request.value, scope.value) : []));
const showSystem = ref(false);
const visible = computed(() => (showSystem.value ? results.value : results.value.filter((s) => !s.system)));
const hiddenCount = computed(() => results.value.filter((s) => s.system).length);
const dangling = computed(() => (index.value ? danglingBindings(index.value) : []));

const opened = ref(new Set<string>());
watch(results, () => opened.value.clear());

/* "in any namespace" goes without saying: each subject says where. */
const askedText = computed(() => questionText(question.value, namespaced.value).replace(/ in every namespace$/, ""));

const summary = computed(() => {
  const count = visible.value.length;
  if (!count) return "";
  return `${count} ${count === 1 ? "subject" : "subjects"} can ${askedText.value}`;
});

const whereText = (access: SubjectAccess) => {
  if (access.everywhere) return "Everywhere";
  if (access.namespaces.length === 1) return `In ${access.namespaces[0]}`;
  return `In ${access.namespaces.length} namespaces`;
};
const whereTitle = (access: SubjectAccess) =>
  access.everywhere ? "Through a ClusterRoleBinding: in every namespace" : access.namespaces.join(", ");
</script>

<template>
  <div class="space-y-6">
    <div class="rounded-xl border bg-card px-6 pb-5 pt-6 shadow-xs">
      <QuestionSentence
        v-model:question="question"
        mode="who"
        :resources="resources"
        :discovery="discovery"
        :namespaces="namespaces"
      />
    </div>

    <div v-if="!rbac" class="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> Reading roles and bindings…
    </div>

    <RbacNotice v-else-if="unavailable.length >= 4" :unavailable="unavailable" @ask-me="emit('askMe')" @retry="emit('retry')" />

    <template v-else>
      <RbacNotice v-if="unavailable.length" :unavailable="unavailable" @ask-me="emit('askMe')" @retry="emit('retry')" />

      <section class="space-y-2">
        <div v-if="results.length" class="flex h-7 items-center justify-between gap-4 px-1">
          <p class="text-sm text-muted-foreground">{{ summary || "Only built-in subjects can do this." }}</p>
          <label v-if="hiddenCount" class="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            Show {{ hiddenCount }} built-in {{ hiddenCount === 1 ? "subject" : "subjects" }}
            <Switch v-model:checked="showSystem" />
          </label>
        </div>

        <EmptyState
          v-if="!results.length"
          :icon="UserX"
          size="sm"
          title="Nobody can do this"
          description="No binding in this cluster grants it, to anyone. Only members of system:masters could: RBAC doesn't apply to them."
          class="rounded-xl border border-dashed py-12"
        />

        <ul v-else-if="visible.length" class="divide-y divide-border-subtle overflow-hidden rounded-xl border bg-card" :class="loading && 'opacity-60'">
          <li v-for="access in visible" :key="access.key" class="flex items-start gap-3.5 px-5 py-3.5">
            <SubjectIcon :kind="access.subject.kind" class="mt-0.5" />
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex min-w-0 items-baseline gap-2">
                <button
                  type="button"
                  class="truncate rounded-sm text-sm font-medium underline-offset-2 hover:underline focus-ring"
                  :title="`What else can ${access.subject.name} do?`"
                  @click="openSubject(access.subject)"
                >
                  {{ access.subject.name }}
                </button>
                <span v-if="subjectHint(access.subject)" class="truncate text-xs text-muted-foreground">{{ subjectHint(access.subject) }}</span>
                <StatusBadge
                  v-if="access.grants.some((g) => g.fullAccess)"
                  tone="warning"
                  :dot="false"
                  title="Can do anything with every resource, like cluster-admin"
                >
                  Full access
                </StatusBadge>
              </div>
              <GrantChain
                v-for="grant in opened.has(access.key) ? access.grants : access.grants.slice(0, 1)"
                :key="`${grant.binding.kind}/${grant.binding.metadata.namespace}/${grant.binding.metadata.name}`"
                :binding="grant.binding"
                :role="grant.role"
                :note="grant.fullAccess ? null : wildcardSummary(grant.rule, request)"
              />
              <button
                v-if="access.grants.length > 1"
                type="button"
                class="inline-flex items-center gap-0.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-ring"
                @click="opened.has(access.key) ? opened.delete(access.key) : opened.add(access.key)"
              >
                <ChevronRight class="h-3 w-3 transition-transform duration-fast" :class="opened.has(access.key) && 'rotate-90'" />
                {{ opened.has(access.key) ? "Fewer" : `${access.grants.length - 1} more ${access.grants.length === 2 ? "way" : "ways"}` }}
              </button>
            </div>
            <span class="shrink-0 pt-0.5 text-xs text-muted-foreground" :title="whereTitle(access)">{{ whereText(access) }}</span>
          </li>
        </ul>
      </section>

      <div class="space-y-3 px-1">
        <DanglingBindings v-if="dangling.length" :bindings="dangling" />
        <p class="text-xs text-muted-foreground/80">
          Members of system:masters can always do everything: RBAC isn't consulted for them. Who's in a group is
          decided by your identity provider, so groups are listed, not their members.
        </p>
      </div>
    </template>
  </div>
</template>
