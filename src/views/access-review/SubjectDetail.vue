<script setup lang="ts">
/*
 * Everything one subject may do, and why: the bindings that apply to it
 * (directly or through a group), then its permissions everywhere and per
 * namespace as matrices whose rows open to their source. Service accounts
 * also show what runs as them.
 */
import { Search } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import SubjectIcon from "@/components/rbac/SubjectIcon.vue";
import GrantChain from "@/components/rbac/GrantChain.vue";
import PermissionMatrix from "@/components/rbac/PermissionMatrix.vue";
import { useRbacLinks } from "@/components/rbac/useRbacLinks";
import { errorMessage, podsOfServiceAccount, workloadsOf, type WorkloadRef } from "@/lib/accessReview";
import { kubeGet, type KubeTarget } from "@/lib/kubeApi";
import {
  effectivePermissions,
  identityOf,
  joinWords,
  permissionMatrix,
  subjectDescription,
  verbPhrase,
  type Grant,
  type SourcedRule,
  type Identity,
  type RbacIndex,
  type RbacSubject,
} from "@/lib/rbac";

const props = defineProps<{
  /** null: you (`identity` from the cluster). */
  subject: RbacSubject | null;
  identity: Identity | null;
  index: RbacIndex;
  target: KubeTarget;
}>();

const { openObject } = useRbacLinks();

const me = computed(() => !props.subject);
const identity = computed<Identity>(() => (props.subject ? identityOf(props.subject) : props.identity ?? { groups: [] }));
const title = computed(() => props.subject?.name ?? "You");
const description = computed(() => {
  if (props.subject) return subjectDescription(props.subject);
  return identity.value.username ?? "";
});
const kind = computed(() => props.subject?.kind ?? "User");

const permissions = computed(() => effectivePermissions(props.index, identity.value));

/*
 * What every signed-in user gets (discovery, health checks, self reviews)
 * says little about a subject: kept out of sight until asked for.
 */
const EVERYONE = new Set(["system:authenticated", "system:unauthenticated"]);
const isCommon = (grant: Grant) => !!grant.viaGroup && EVERYONE.has(grant.viaGroup);
const showCommon = ref(false);
const own = computed(() => permissions.value.grants.filter((g) => !isCommon(g)));
const common = computed(() => permissions.value.grants.filter(isCommon));
const grants = computed(() => (showCommon.value ? [...own.value, ...common.value] : own.value));
const counted = (rules: SourcedRule<Grant>[]) => (showCommon.value ? rules : rules.filter((r) => !isCommon(r.source)));

const sections = computed(() => {
  const everywhere = counted(permissions.value.everywhere);
  return [
    ...(everywhere.length
      ? [{ key: "@everywhere", title: "Everywhere", caption: "Granted by ClusterRoleBindings: in every namespace, and for cluster-wide resources.", matrix: permissionMatrix(everywhere) }]
      : []),
    ...[...permissions.value.namespaces]
      .map(([namespace, rules]) => [namespace, counted(rules)] as const)
      .filter(([, rules]) => rules.length)
      .map(([namespace, rules]) => ({
        key: namespace,
        title: `In ${namespace}`,
        caption: `Granted by RoleBindings in ${namespace}: only there, on top of everything above.`,
        matrix: permissionMatrix(rules),
      })),
  ];
});

/* Groups it's in (implicit ones for service accounts), the ones that matter first. */
const groups = computed(() => identity.value.groups.filter((g) => props.subject?.kind !== "Group" || g !== props.subject.name));
const usedGroups = computed(() => new Set(own.value.map((g) => g.viaGroup).filter(Boolean)));

const filter = ref("");
watch(
  () => props.subject,
  () => (filter.value = "")
);

const where = (grant: Grant) => (grant.namespace === null ? "Everywhere" : `In ${grant.namespace}`);
const describeSource = (grant: Grant) => `${grant.binding.roleRef.kind} ${grant.binding.roleRef.name}`;

/* ------------------------------------------------- what runs as it (SA) -- */

const workloads = ref<WorkloadRef[] | null>(null);
const workloadsError = ref<string | null>(null);
watch(
  () => [props.subject, props.target] as const,
  async ([subject, target]) => {
    workloads.value = null;
    workloadsError.value = null;
    if (subject?.kind !== "ServiceAccount" || !subject.namespace) return;
    try {
      const pods = await podsOfServiceAccount(target, subject.namespace, subject.name);
      if (props.subject === subject) workloads.value = workloadsOf(pods);
    } catch (error) {
      if (props.subject === subject) workloadsError.value = errorMessage(error);
    }
  },
  { immediate: true }
);

const openServiceAccount = async () => {
  const subject = props.subject;
  if (subject?.kind !== "ServiceAccount" || !subject.namespace) return;
  const account = await kubeGet(props.target, `/api/v1/namespaces/${encodeURIComponent(subject.namespace)}/serviceaccounts/${encodeURIComponent(subject.name)}`).catch(() => null);
  if (account) {
    openObject({
      ...account,
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { ...account.metadata, context: props.target.context, kubeConfig: props.target.kubeConfig ?? "" },
    });
  }
};
</script>

<template>
  <article class="min-w-0 space-y-6" :aria-label="`Permissions of ${title}`">
    <header class="flex items-start gap-3.5">
      <SubjectIcon :kind="kind" size="lg" class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-lg font-semibold tracking-tight">{{ title }}</h2>
        <p class="truncate text-sm text-muted-foreground">{{ description }}</p>
      </div>
      <Button v-if="subject?.kind === 'ServiceAccount'" variant="outline" size="sm" @click="openServiceAccount">Details</Button>
    </header>

    <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      <template v-if="subject?.kind === 'ServiceAccount'">
        <dt class="text-muted-foreground">Runs</dt>
        <dd class="min-w-0">
          <span v-if="workloadsError" class="text-muted-foreground">Couldn't list its pods: {{ workloadsError }}</span>
          <span v-else-if="!workloads" class="text-muted-foreground">…</span>
          <span v-else-if="!workloads.length" class="text-muted-foreground">No pods run as it right now.</span>
          <span v-else class="flex flex-wrap gap-x-4 gap-y-1">
            <span v-for="workload in workloads" :key="`${workload.kind}/${workload.name}`">
              <span class="text-muted-foreground">{{ workload.kind }}</span> {{ workload.name }}
              <span class="text-muted-foreground">· {{ workload.pods }} {{ workload.pods === 1 ? "pod" : "pods" }}</span>
            </span>
          </span>
        </dd>
      </template>
      <template v-if="groups.length && subject?.kind !== 'Group'">
        <dt class="text-muted-foreground">{{ me ? "Your groups" : "Also counts as" }}</dt>
        <dd class="min-w-0 leading-6">
          <template v-for="(group, i) in groups" :key="group">
            <span :class="usedGroups.has(group) ? 'text-foreground' : 'text-muted-foreground'">{{ group }}</span><span v-if="i < groups.length - 1" class="text-muted-foreground">, </span>
          </template>
        </dd>
      </template>
    </dl>

    <p v-if="subject?.kind === 'User'" class="text-xs text-muted-foreground">
      Which groups a user is in is up to your identity provider, so this shows what's granted to {{ subject.name }}
      by name and to everyone who's signed in.
    </p>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold">How {{ me ? "you get" : "it gets" }} access</h3>
      <p v-if="!own.length && !common.length" class="text-sm text-muted-foreground">
        No binding applies to {{ me ? "you" : title }}, so {{ me ? "you" : "it" }} can't do anything through RBAC.
      </p>
      <p v-else-if="!own.length && !showCommon" class="text-sm text-muted-foreground">
        Nothing beyond what everyone who's signed in may do.
      </p>
      <ul v-if="grants.length" class="divide-y divide-border-subtle overflow-hidden rounded-xl border bg-card">
        <li v-for="grant in grants" :key="`${grant.binding.kind}/${grant.binding.metadata.namespace}/${grant.binding.metadata.name}`" class="flex items-center gap-4 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <GrantChain :binding="grant.binding" :role="grant.role" :via-group="grant.viaGroup" />
            <p v-if="!grant.role" class="text-xs text-warning">The role doesn't exist, so this grants nothing.</p>
          </div>
          <span class="shrink-0 text-xs text-muted-foreground">{{ where(grant) }}</span>
        </li>
      </ul>
      <button
        v-if="common.length"
        type="button"
        class="inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        :aria-pressed="showCommon"
        @click="showCommon = !showCommon"
      >
        <template v-if="showCommon">Leave out what everyone who's signed in gets</template>
        <template v-else>
          Include {{ common.length }} {{ common.length === 1 ? "grant" : "grants" }} everyone who's signed in gets
        </template>
      </button>
    </section>

    <template v-if="sections.length">
      <div class="flex items-center justify-between gap-4 border-t pt-6">
        <h3 class="text-sm font-semibold">What {{ me ? "you" : "it" }} can do</h3>
        <div class="relative w-60">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            v-model="filter"
            type="text"
            spellcheck="false"
            placeholder="Find a resource"
            aria-label="Find a resource"
            class="h-8 w-full rounded-lg border border-transparent bg-muted/60 pl-8 pr-3 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15"
          />
        </div>
      </div>
      <section v-for="section in sections" :key="section.key" class="space-y-3">
        <div class="space-y-0.5">
          <h4 class="text-sm font-medium">{{ section.title }}</h4>
          <p class="text-xs text-muted-foreground">{{ section.caption }}</p>
        </div>
        <PermissionMatrix :matrix="section.matrix" :query="filter" :who="me ? 'You' : title" :describe="describeSource">
          <template #source="{ source, verbs }">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <GrantChain :binding="source.binding" :role="source.role" :via-group="source.viaGroup" />
              <span class="text-xs text-muted-foreground">({{ verbPhrase(verbs) === "do anything with" ? "every verb" : joinWords(verbs) }})</span>
            </div>
          </template>
        </PermissionMatrix>
      </section>
    </template>
  </article>
</template>
