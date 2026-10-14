<script setup lang="ts">
/*
 * Subjects: every user, group and service account a binding names (and
 * you), searchable, next to what the picked one may do. Built-in subjects
 * stay out of the list until asked for.
 */
import { Loader2, Search, X } from "lucide-vue-next";
import { Switch } from "@/components/ui/switch";
import SubjectIcon from "@/components/rbac/SubjectIcon.vue";
import RbacNotice from "@/components/rbac/RbacNotice.vue";
import SubjectDetail from "./SubjectDetail.vue";
import { indexRbac, parseSubjectKey, subjectsOf, type Identity, type NamespacedLookup, type RbacSubject } from "@/lib/rbac";
import type { RbacData } from "@/lib/accessReview";
import type { KubeTarget } from "@/lib/kubeApi";

const ME = "@me";

const props = defineProps<{
  target: KubeTarget;
  rbac: RbacData | null;
  loading: boolean;
  identity: Identity | null;
  identityPending: boolean;
  namespaced: NamespacedLookup;
}>();
const selected = defineModel<string | null>("selected", { required: true });
const emit = defineEmits<{ askMe: []; retry: [] }>();

const index = computed(() => (props.rbac ? indexRbac(props.rbac.snapshot) : null));
const unavailable = computed(() => props.rbac?.unavailable ?? []);
const all = computed(() => (index.value ? subjectsOf(index.value) : []));

const query = ref("");
const showSystem = ref(false);
const q = computed(() => query.value.trim().toLowerCase());

const matches = (subject: RbacSubject) =>
  !q.value || `${subject.name} ${subject.namespace ?? ""} ${subject.kind}`.toLowerCase().includes(q.value);

const SECTIONS = [
  { kind: "User", title: "Users" },
  { kind: "Group", title: "Groups" },
  { kind: "ServiceAccount", title: "Service accounts" },
] as const;

const sections = computed(() => {
  const listed = all.value.filter((s) => (showSystem.value || !s.system) && matches(s.subject));
  return SECTIONS.map((section) => ({
    ...section,
    items: listed.filter((s) => s.subject.kind === section.kind),
  })).filter((section) => section.items.length);
});
const hiddenCount = computed(() => all.value.filter((s) => s.system).length);
const showMe = computed(() => !!props.identity && (!q.value || "you".includes(q.value) || (props.identity.username ?? "").toLowerCase().includes(q.value)));

/* A deep-linked subject that no binding names still opens (it has no access). */
const subject = computed<RbacSubject | null>(() =>
  selected.value && selected.value !== ME ? parseSubjectKey(selected.value) : null
);
const showingMe = computed(() => selected.value === ME && !!props.identity);

watch(
  [() => props.identity, () => props.identityPending, all],
  () => {
    if (selected.value || props.identityPending) return;
    if (props.identity) selected.value = ME;
    else if (all.value.length) selected.value = all.value.find((s) => !s.system)?.key ?? all.value[0].key;
  },
  { immediate: true }
);

/* Picking one that's hidden (a built-in subject) shows the built-in ones. */
watch(
  selected,
  (key) => {
    if (key && all.value.find((s) => s.key === key)?.system) showSystem.value = true;
  },
  { immediate: true }
);

const rowClass = (key: string) =>
  selected.value === key ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/50";
</script>

<template>
  <div v-if="!rbac" class="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
    <Loader2 class="h-4 w-4 animate-spin" /> Reading roles and bindings…
  </div>

  <RbacNotice v-else-if="unavailable.length >= 4" :unavailable="unavailable" @ask-me="emit('askMe')" @retry="emit('retry')" />

  <div v-else class="space-y-4">
    <RbacNotice v-if="unavailable.length" :unavailable="unavailable" @ask-me="emit('askMe')" @retry="emit('retry')" />

    <div class="flex items-start gap-10">
      <nav class="w-64 shrink-0 space-y-4" aria-label="Subjects">
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="Find a subject"
            aria-label="Find a subject"
            class="h-8 w-full rounded-lg border border-transparent bg-muted/60 pl-8 pr-8 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15"
          />
          <button
            v-if="query"
            type="button"
            class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
            @click="query = ''"
          >
            <X class="h-3 w-3" />
          </button>
        </div>

        <button
          v-if="showMe"
          type="button"
          class="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-fast focus-ring"
          :class="rowClass(ME)"
          :aria-current="selected === ME"
          @click="selected = ME"
        >
          <SubjectIcon kind="User" size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">You</span>
            <span class="block truncate text-xs text-muted-foreground">{{ identity?.username }}</span>
          </span>
        </button>

        <section v-for="section in sections" :key="section.kind">
          <h3 class="mb-1 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
            {{ section.title }} <span class="font-normal tabular-nums">{{ section.items.length }}</span>
          </h3>
          <div class="space-y-px">
            <button
              v-for="item in section.items"
              :key="item.key"
              type="button"
              class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-fast focus-ring"
              :class="rowClass(item.key)"
              :aria-current="selected === item.key"
              :title="item.subject.name"
              @click="selected = item.key"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ item.subject.name }}</span>
                <span v-if="item.subject.namespace" class="block truncate text-xs text-muted-foreground">{{ item.subject.namespace }}</span>
              </span>
            </button>
          </div>
        </section>

        <p v-if="!sections.length && !showMe" class="px-2 text-sm text-muted-foreground">Nothing matches.</p>

        <label v-if="hiddenCount" class="flex cursor-pointer items-center justify-between gap-2 border-t px-2 pt-3 text-xs text-muted-foreground">
          Show {{ hiddenCount }} built-in {{ hiddenCount === 1 ? "subject" : "subjects" }}
          <Switch v-model:checked="showSystem" />
        </label>
      </nav>

      <div class="min-w-0 flex-1">
        <SubjectDetail
          v-if="index && (subject || showingMe)"
          :key="selected ?? ''"
          :subject="subject"
          :identity="identity"
          :index="index"
          :target="target"
          :namespaced="namespaced"
        />
        <p v-else class="py-24 text-center text-sm text-muted-foreground">Pick a subject to see what it can do.</p>
      </div>
    </div>
  </div>
</template>
