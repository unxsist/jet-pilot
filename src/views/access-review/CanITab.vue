<script setup lang="ts">
/*
 * Can I …? The API server answers (SelfSubjectAccessReview) as you edit
 * the question, with the binding → role → rule behind a yes. Below: all I
 * may do in a namespace (SelfSubjectRulesReview) as a matrix. Neither
 * needs permission to read RBAC.
 */
import { Ban, Check, ChevronRight, Loader2, Search, X } from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import QuestionSentence from "@/components/rbac/QuestionSentence.vue";
import TokenPicker from "@/components/rbac/TokenPicker.vue";
import GrantChain from "@/components/rbac/GrantChain.vue";
import PermissionMatrix from "@/components/rbac/PermissionMatrix.vue";
import {
  EVERY_NAMESPACE,
  isNamespaced,
  parseResourceValue,
  questionText,
  requestOf,
  URL_RESOURCE,
  type Question,
} from "@/components/rbac/question";
import { canI, errorMessage, myRules, type AccessDecision, type RbacData, type RulesReview } from "@/lib/accessReview";
import {
  indexRbac,
  isNonResourceRequest,
  matchingRule,
  parseAllowReason,
  permissionMatrix,
  wildcardSummary,
  type BindingObject,
} from "@/lib/rbac";
import type { DiscoveredResource, DiscoverySnapshot } from "@/lib/discovery";
import type { KubeTarget } from "@/lib/kubeApi";

const props = defineProps<{
  target: KubeTarget;
  resources: DiscoveredResource[];
  discovery: DiscoverySnapshot | null;
  namespaces: string[];
  rbac: RbacData | null;
}>();
const question = defineModel<Question>("question", { required: true });
const emit = defineEmits<{ askWho: [] }>();

const namespaced = computed(() => {
  if (question.value.resource === URL_RESOURCE) return false;
  const { resource, group } = parseResourceValue(question.value.resource);
  return isNamespaced(props.resources, resource, group);
});
const request = computed(() => requestOf(question.value, namespaced.value));
const asked = computed(() => questionText(question.value, namespaced.value));

/* ------------------------------------------------------------ the answer -- */

const decision = ref<AccessDecision | null>(null);
const answeredFor = ref("");
const asking = ref(false);
const askError = ref<string | null>(null);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const ask = async () => {
  const run = ++generation;
  const current = request.value;
  const text = asked.value;
  asking.value = true;
  try {
    const answer = await canI(
      props.target,
      isNonResourceRequest(current) ? { verb: current.verb, path: current.path } : current
    );
    if (run !== generation) return;
    decision.value = answer;
    answeredFor.value = text;
    askError.value = null;
  } catch (error) {
    if (run !== generation) return;
    decision.value = null;
    askError.value = errorMessage(error);
  } finally {
    if (run === generation) asking.value = false;
  }
};

watch(
  [() => JSON.stringify(request.value), () => props.target],
  () => {
    clearTimeout(timer);
    // Typing a name shouldn't ask on every key.
    timer = setTimeout(ask, decision.value ? 250 : 0);
  },
  { immediate: true }
);
onUnmounted(() => clearTimeout(timer));

/* The RBAC authorizer's reason as a chain, linked when the objects can be read. */
const chain = computed(() => {
  const reason = parseAllowReason(decision.value?.allowed ? decision.value.reason : null);
  if (!reason) return null;
  const snapshot = props.rbac?.snapshot;
  const bindings = reason.binding.kind === "ClusterRoleBinding" ? snapshot?.clusterRoleBindings : snapshot?.roleBindings;
  const found = bindings?.find(
    (b) => b.metadata.name === reason.binding.name && (b.metadata.namespace ?? undefined) === reason.binding.namespace
  );
  const binding: BindingObject = found ?? {
    kind: reason.binding.kind,
    metadata: { name: reason.binding.name, namespace: reason.binding.namespace },
    roleRef: { kind: reason.role.kind, name: reason.role.name },
  };
  const role = found && snapshot ? indexRbac(snapshot).roleOf(found) : null;
  const rule = role ? matchingRule(role, request.value)?.rule : undefined;
  return {
    binding,
    role,
    wildcard: rule ? wildcardSummary(rule, request.value) : null,
    viaGroup: reason.subject.kind === "Group" ? reason.subject.name : undefined,
    readable: !!found,
  };
});

const otherReason = computed(() => (!chain.value && decision.value?.reason ? decision.value.reason : null));

/* Questions people ask a lot, and the RBAC words they come down to. */
const SUGGESTIONS: { label: string; question: Partial<Question> }[] = [
  { label: "read secrets", question: { verb: "get", resource: "secrets", subresource: "", name: "" } },
  { label: "exec into pods", question: { verb: "create", resource: "pods", subresource: "exec", name: "" } },
  { label: "port-forward", question: { verb: "create", resource: "pods", subresource: "portforward", name: "" } },
  { label: "scale deployments", question: { verb: "patch", resource: "deployments.apps", subresource: "scale", name: "" } },
  { label: "delete namespaces", question: { verb: "delete", resource: "namespaces", subresource: "", name: "" } },
  { label: "grant roles", question: { verb: "create", resource: "rolebindings.rbac.authorization.k8s.io", subresource: "", name: "" } },
];
const suggest = (patch: Partial<Question>) => Object.assign(question.value, patch);

/* ------------------------------------------------------- my permissions -- */

const rulesNamespace = ref("");
watch(
  () => question.value.namespace,
  (namespace) => {
    if (namespace && namespace !== EVERY_NAMESPACE) rulesNamespace.value = namespace;
    else if (!rulesNamespace.value) rulesNamespace.value = props.namespaces.includes("default") ? "default" : props.namespaces[0] ?? "default";
  },
  { immediate: true }
);
const namespaceOptions = computed(() => props.namespaces.map((ns) => ({ value: ns, label: ns })));

const rules = ref<RulesReview | null>(null);
const rulesLoading = ref(false);
const rulesError = ref<string | null>(null);
const filter = ref("");
let rulesGeneration = 0;

watch(
  [() => props.target, rulesNamespace],
  async ([target, namespace]) => {
    const run = ++rulesGeneration;
    rulesLoading.value = true;
    try {
      const review = await myRules(target, namespace);
      if (run !== rulesGeneration) return;
      rules.value = review;
      rulesError.value = null;
    } catch (error) {
      if (run !== rulesGeneration) return;
      rules.value = null;
      rulesError.value = errorMessage(error);
    } finally {
      if (run === rulesGeneration) rulesLoading.value = false;
    }
  },
  { immediate: true }
);

const matrix = computed(() =>
  rules.value ? permissionMatrix(rules.value.rules.map((rule) => ({ rule, source: null }))) : null
);
</script>

<template>
  <div class="space-y-10">
    <section class="space-y-3">
      <div class="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div class="px-6 pb-5 pt-6">
          <QuestionSentence
            v-model:question="question"
            mode="me"
            :resources="resources"
            :discovery="discovery"
            :namespaces="namespaces"
          />
        </div>

        <div class="border-t border-border-subtle px-6 py-5" aria-live="polite">
          <div v-if="askError" class="flex items-start gap-4">
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <X class="h-5 w-5" />
            </span>
            <div class="min-w-0 space-y-1 pt-0.5">
              <p class="text-lg font-semibold tracking-tight">Couldn't ask the cluster</p>
              <p class="break-words text-sm text-muted-foreground">{{ askError }}</p>
            </div>
          </div>

          <div v-else-if="decision" class="flex items-start gap-4 transition-opacity duration-fast" :class="asking && 'opacity-60'">
            <span
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              :class="decision.allowed ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'"
            >
              <Check v-if="decision.allowed" class="h-5 w-5" stroke-width="2.25" />
              <Ban v-else class="h-5 w-5" />
            </span>
            <div class="min-w-0 flex-1 space-y-1.5 pt-0.5">
              <p class="text-lg font-semibold tracking-tight">
                {{ decision.allowed ? "Yes" : "No" }}, you {{ decision.allowed ? "can" : "can't" }} {{ answeredFor }}.
              </p>
              <template v-if="decision.allowed">
                <div v-if="chain" class="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <span v-if="chain.viaGroup">Granted to your group <span class="text-foreground">{{ chain.viaGroup }}</span> by</span>
                  <span v-else>Granted to you by</span>
                  <GrantChain :binding="chain.binding" :role="chain.role" :readable="chain.readable" size="sm" />
                </div>
                <p v-if="chain?.wildcard" class="text-sm text-muted-foreground">
                  The role allows it with a wildcard: {{ chain.wildcard }}.
                </p>
                <p v-else-if="otherReason" class="text-sm text-muted-foreground">{{ otherReason }}</p>
                <p v-else-if="!chain" class="text-sm text-muted-foreground">
                  The cluster allows it outside RBAC (an admin group or another authorizer), so there's no binding
                  to show.
                </p>
              </template>
              <template v-else>
                <p class="text-sm text-muted-foreground">
                  {{ decision.reason || "Nothing in the cluster grants you this." }}
                </p>
                <button
                  type="button"
                  class="inline-flex items-center gap-0.5 rounded text-sm font-medium text-link hover:underline focus-ring"
                  @click="emit('askWho')"
                >
                  See who can <ChevronRight class="h-3.5 w-3.5" />
                </button>
              </template>
              <p v-if="decision.evaluationError" class="text-xs text-warning">
                The cluster had trouble checking some rules: {{ decision.evaluationError }}
              </p>
            </div>
          </div>

          <div v-else class="flex h-10 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" /> Asking the cluster…
          </div>
        </div>
      </div>

      <p class="flex flex-wrap items-center gap-x-1 gap-y-1 px-1 text-xs text-muted-foreground">
        <span class="mr-1">Try</span>
        <template v-for="(suggestion, i) in SUGGESTIONS" :key="suggestion.label">
          <span v-if="i > 0" aria-hidden="true" class="text-muted-foreground/60">·</span>
          <button
            type="button"
            class="rounded px-0.5 text-foreground/80 transition-colors duration-fast hover:text-link focus-ring"
            @click="suggest(suggestion.question)"
          >
            {{ suggestion.label }}
          </button>
        </template>
      </p>
    </section>

    <section class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div class="space-y-1">
          <h2 class="text-base font-semibold tracking-tight">
            What you can do in
            <TokenPicker v-model="rulesNamespace" :options="namespaceOptions" label="Namespace" custom />
          </h2>
          <p class="text-sm text-muted-foreground">
            Everything the cluster lets you do there, including what you may do everywhere.
          </p>
        </div>
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

      <div v-if="rulesError" class="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
        Couldn't list your permissions: {{ rulesError }}
      </div>
      <div v-else-if="!matrix" class="space-y-2 rounded-xl border p-4" aria-label="Loading your permissions">
        <Skeleton v-for="i in 6" :key="i" class="h-7 w-full" />
      </div>
      <template v-else>
        <PermissionMatrix
          :matrix="matrix"
          :query="filter"
          who="You"
          :class="rulesLoading && 'opacity-60 transition-opacity duration-fast'"
        />
        <p v-if="rules?.incomplete" class="px-1 text-xs text-muted-foreground">
          This list may be incomplete: the cluster also uses an authorizer that can't list its rules (often the
          cloud's IAM). The answer above is always complete.
        </p>
      </template>
    </section>
  </div>
</template>
