<script setup lang="ts">
/*
 * Access review: the three questions people have about RBAC.
 *
 *   Can I …?   asked of the API server (SelfSubjectAccessReview), so it's
 *              right for every authorizer, plus everything I may do in a
 *              namespace (SelfSubjectRulesReview).
 *   Who can …? worked out here from Roles, ClusterRoles and their bindings,
 *              with the binding → role → rule behind every answer.
 *   Subjects   what a user, group or service account may do, and why.
 *
 * Can I and Who can share one question, so switching tabs turns "Can I
 * delete secrets?" into "Who can delete secrets?". Works on the primary
 * context; `?context=` picks another active one, `?tab=` and `?subject=`
 * (a subject key) open a tab and a subject, and `?verb=`, `?resource=`
 * (e.g. deployments.apps), `?namespace=`, `?name=`, `?subresource=` and
 * `?path=` ask a question.
 */
import { useRoute, useRouter } from "vue-router";
import { Check, ChevronsUpDown, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import PageHeader from "@/components/page/PageHeader.vue";
import PageTabs from "@/components/page/PageTabs.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { useDiscovery } from "@/lib/discovery";
import { resolveCluster } from "@/lib/clusters/meta";
import { Kubernetes } from "@/services/Kubernetes";
import { useRbacData, whoAmI } from "@/lib/accessReview";
import type { Identity, NamespacedLookup } from "@/lib/rbac";
import type { KubeTarget } from "@/lib/kubeApi";
import type { Question } from "@/components/rbac/question";

/* Each tab loads on its first visit (and keeps the startup bundle lean). */
const CanITab = defineAsyncComponent(() => import("./CanITab.vue"));
const WhoCanTab = defineAsyncComponent(() => import("./WhoCanTab.vue"));
const SubjectsTab = defineAsyncComponent(() => import("./SubjectsTab.vue"));

type Tab = "can" | "who" | "subjects";
const TABS = ["can", "who", "subjects"] as const;

const route = useRoute();
const router = useRouter();
const { context, kubeConfig, namespace, contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);

/* ------------------------------------------------------------ context -- */

const picked = ref<string | null>(null);
const contextName = computed(() =>
  picked.value && contexts.value.has(picked.value) ? picked.value : context.value
);
const target = computed<KubeTarget | null>(() => {
  const name = contextName.value;
  if (!name) return null;
  const config = contextKubeConfigMapping.value.get(name) ?? (name === context.value ? kubeConfig.value : "");
  return { context: name, kubeConfig: config };
});
const targetContext = computed(() => target.value?.context ?? "");
const targetKubeConfig = computed(() => target.value?.kubeConfig ?? "");
const displayName = (name: string) =>
  resolveCluster(settings.value.clusters, name, contextKubeConfigMapping.value.get(name)).displayName;

/* -------------------------------------------------------------- route -- */

const tab = ref<Tab>("can");
const subject = ref<string | null>(null);
watch(
  () => [route.query.tab, route.query.subject, route.query.context],
  ([queryTab, querySubject, queryContext]) => {
    if (route.name !== "AccessReview") return;
    tab.value = TABS.includes(queryTab as Tab) ? (queryTab as Tab) : "can";
    if (typeof querySubject === "string") subject.value = querySubject;
    if (typeof queryContext === "string") picked.value = queryContext;
  },
  { immediate: true }
);
watch(tab, (value) => {
  if (route.query.tab !== value) router.replace({ query: { ...route.query, tab: value === "can" ? undefined : value } });
});
watch(subject, (value) => {
  if (value && route.query.subject !== value) router.replace({ query: { ...route.query, subject: value } });
});

/* --------------------------------------------------------------- data -- */

const discovery = useDiscovery(targetContext, targetKubeConfig);
/* Which resources are namespaced: RoleBindings can't grant the others. */
const namespacedLookup = computed<NamespacedLookup>(() => {
  const scopes = new Map(discovery.resources.value.map((r) => [`${r.group}/${r.name}`, r.namespaced]));
  return (group, resource) => scopes.get(`${group}/${resource}`);
});
const rbac = useRbacData(target);

const identity = ref<Identity | null>(null);
/* Still asking who I am (Subjects waits for it to pick "You" first). */
const identityPending = ref(true);
watch(
  target,
  async (now) => {
    identity.value = null;
    identityPending.value = !!now;
    if (!now) return;
    const me = await whoAmI(now);
    if (target.value !== now) return;
    identity.value = me;
    identityPending.value = false;
  },
  { immediate: true }
);

/* Namespaces to ask about: the cluster's, else the ones RBAC mentions. */
const listedNamespaces = ref<string[]>([]);
watch(
  target,
  async (now) => {
    listedNamespaces.value = [];
    if (!now) return;
    try {
      const list = await Kubernetes.getNamespaces(now.context, now.kubeConfig ?? "");
      if (target.value === now) listedNamespaces.value = list.map((ns) => ns.metadata?.name ?? "").filter(Boolean);
    } catch {
      // Not allowed to list them: typed names and RBAC's namespaces still work.
    }
  },
  { immediate: true }
);
const namespaces = computed(() => {
  const all = new Set(listedNamespaces.value);
  for (const binding of rbac.data.value?.snapshot.roleBindings ?? []) {
    if (binding.metadata.namespace) all.add(binding.metadata.namespace);
  }
  return [...all].sort();
});

/* The namespace you're looking at, else the context's, else default. */
const defaultNamespace = computed(() => {
  const selected = contexts.value.get(contextName.value) ?? [];
  if (selected.length === 1 && selected[0] !== "all") return selected[0];
  if (contextName.value === context.value && namespace.value && namespace.value !== "all") return namespace.value;
  return namespaces.value.includes("default") || !namespaces.value.length ? "default" : namespaces.value[0];
});

const question = reactive<Question>({
  verb: "list",
  resource: "secrets",
  namespace: "",
  name: "",
  subresource: "",
  path: "/metrics",
});
watch(
  [target, defaultNamespace],
  ([now, ns], [before]) => {
    if (!question.namespace || now !== before) question.namespace = ns;
  },
  { immediate: true }
);
/* Only when the link's question changes: switching tabs keeps your edits. */
const QUESTION_KEYS = ["verb", "resource", "namespace", "name", "subresource", "path"] as const;
watch(
  () => QUESTION_KEYS.map((key) => route.query[key] ?? "").join("\n"),
  () => {
    if (route.name !== "AccessReview") return;
    for (const key of QUESTION_KEYS) {
      const value = route.query[key];
      if (typeof value === "string") question[key] = value;
    }
  },
  { immediate: true }
);


const subtitle = computed(() => {
  const name = contextName.value ? displayName(contextName.value) : "";
  if (identity.value?.username) return `Signed in to ${name} as ${identity.value.username}`;
  return `Who can do what on ${name}, and why`;
});

const refresh = () => rbac.refresh();
</script>

<template>
  <div class="h-full overflow-auto bg-background">
    <div class="mx-auto max-w-5xl space-y-6 px-10 pb-16 pt-10">
      <PageHeader title="Access review" :description="subtitle">
        <template #actions>
          <DropdownMenu v-if="contexts.size > 1">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="h-9 gap-2 px-2.5 text-muted-foreground" aria-label="Cluster to review">
                <ContextAvatar :name="contextName" :kube-config="targetKubeConfig" size="sm" />
                <span class="max-w-xs truncate text-foreground">{{ displayName(contextName) }}</span>
                <ChevronsUpDown class="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-60">
              <DropdownMenuLabel>Review access on</DropdownMenuLabel>
              <DropdownMenuItem v-for="name in contexts.keys()" :key="name" @select="picked = name">
                <ContextAvatar :name="name" :kube-config="contextKubeConfigMapping.get(name)" size="sm" />
                <span class="truncate">{{ displayName(name) }}</span>
                <Check v-if="name === contextName" class="ml-auto h-3.5 w-3.5 text-link" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            v-if="tab !== 'can'"
            variant="ghost"
            size="icon"
            class="text-muted-foreground"
            aria-label="Reload roles and bindings"
            title="Reload roles and bindings"
            :disabled="rbac.loading.value"
            @click="refresh"
          >
            <RefreshCw class="h-4 w-4" :class="rbac.loading.value && 'animate-spin'" />
          </Button>
        </template>
        <template #tabs>
          <PageTabs
            v-model="tab"
            label="Access review"
            :tabs="[
              { id: 'can', label: 'Can I…' },
              { id: 'who', label: 'Who can…' },
              { id: 'subjects', label: 'Subjects' },
            ]"
          />
        </template>
      </PageHeader>

      <template v-if="target">
        <CanITab
          v-if="tab === 'can'"
          :target="target"
          :question="question"
          :resources="discovery.resources.value"
          :discovery="discovery.snapshot.value"
          :namespaces="namespaces"
          :rbac="rbac.data.value"
          @ask-who="tab = 'who'"
        />
        <WhoCanTab
          v-else-if="tab === 'who'"
          :question="question"
          :resources="discovery.resources.value"
          :discovery="discovery.snapshot.value"
          :namespaces="namespaces"
          :rbac="rbac.data.value"
          :loading="rbac.loading.value"
          @ask-me="tab = 'can'"
          @retry="refresh"
        />
        <SubjectsTab
          v-else
          v-model:selected="subject"
          :target="target"
          :rbac="rbac.data.value"
          :loading="rbac.loading.value"
          :identity="identity"
          :identity-pending="identityPending"
          :namespaced="namespacedLookup"
          @ask-me="tab = 'can'"
          @retry="refresh"
        />
      </template>
    </div>
  </div>
</template>
