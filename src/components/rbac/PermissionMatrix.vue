<script setup lang="ts" generic="S">
/**
 * Permissions as a calm matrix: resources down, the everyday verbs across,
 * a dot where it's allowed. Grouped by API group (big groups start
 * collapsed), long groups show their first rows, and a row opens to show
 * where its permissions come from (the `source` slot). Names-only grants
 * and other verbs are spelled out under the resource.
 */
import type { VNode } from "vue";
import { ChevronRight, ShieldAlert } from "lucide-vue-next";
import {
  MATRIX_VERBS,
  groupLabel,
  joinWords,
  otherVerbs,
  rowGrants,
  sourcesOfVerb,
  type PermissionMatrix,
  type PermissionRow,
} from "@/lib/rbac";

const props = withDefaults(
  defineProps<{
    matrix: PermissionMatrix<S>;
    /** Only rows whose resource, group or names contain this. */
    query?: string;
    /** Words for a source, in the hover text of a dot. */
    describe?: (source: S) => string;
    /** Whom the full-access note is about ("You", "This service account"). */
    who?: string;
  }>(),
  { query: "", describe: undefined, who: "This subject" }
);

const slots = defineSlots<{ source?(props: { source: S; verbs: string[] }): VNode[] }>();
/* Rows open to their sources only when there's a way to show them. */
const expandable = computed(() => !!slots.source);

const ROW_LIMIT = 10;
const FEW_ROWS = 16;

const q = computed(() => props.query.trim().toLowerCase());
const rowMatches = (row: PermissionRow<S>, group: string) =>
  !q.value || `${row.resource} ${group} ${groupLabel(group)} ${row.names.join(" ")}`.toLowerCase().includes(q.value);

const groups = computed(() =>
  props.matrix.groups
    .map((g) => ({ ...g, visibleRows: g.rows.filter((row) => rowMatches(row, g.group)) }))
    .filter((g) => g.visibleRows.length)
);
const urls = computed(() =>
  props.matrix.nonResource.filter((row) => !q.value || row.path.toLowerCase().includes(q.value))
);

/* Small matrices open fully; big ones open the wildcard and core groups. */
const closed = ref(new Set<string>());
const expanded = ref(new Set<string>());
const showAll = ref(new Set<string>());
watch(
  () => props.matrix,
  (matrix) => {
    const big = matrix.rowCount > FEW_ROWS || matrix.fullAccess.length > 0;
    // URL paths (discovery, health checks) are rarely the point: closed unless they're all there is.
    closed.value = new Set([
      ...(big ? matrix.groups.map((g) => g.group).filter((g) => g !== "*" && g !== "") : []),
      ...(matrix.groups.length ? ["@urls"] : []),
    ]);
    if (matrix.fullAccess.length) closed.value.add("");
    expanded.value = new Set();
    showAll.value = new Set();
  },
  { immediate: true }
);
const isOpen = (group: string) => !!q.value || !closed.value.has(group);
const toggle = (set: Set<string>, key: string) => (set.has(key) ? set.delete(key) : set.add(key));

const rowsOf = (group: { group: string; visibleRows: PermissionRow<S>[] }) =>
  q.value || showAll.value.has(group.group) ? group.visibleRows : group.visibleRows.slice(0, ROW_LIMIT);

const resourceText = (resource: string) => {
  if (resource === "*") return { main: "Every resource", sub: "" };
  if (resource.startsWith("*/")) return { main: `Every resource`, sub: `/${resource.slice(2)}` };
  const slash = resource.indexOf("/");
  return slash < 0 ? { main: resource, sub: "" } : { main: resource.slice(0, slash), sub: resource.slice(slash) };
};

const dotTitle = (row: PermissionRow<S>, verb: string) => {
  if (!rowGrants(row, verb)) return `Can't ${verb}`;
  const from = props.describe ? sourcesOfVerb(row, verb).map(props.describe) : [];
  return from.length ? `Can ${verb}, from ${joinWords(from)}` : `Can ${verb}`;
};

const verbsOfSource = (row: PermissionRow<S>, source: S) =>
  [...row.sourcesByVerb.entries()].filter(([, sources]) => sources.includes(source)).map(([verb]) => verb);

/* The "Also" column (rarer verbs in words) only when a row has some. */
const hasOther = computed(() => props.matrix.groups.some((g) => g.rows.some((r) => r.all || otherVerbs(r).length)));
</script>

<template>
  <div class="space-y-4">
    <div
      v-if="matrix.fullAccess.length && !q"
      class="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/[0.06] px-4 py-3"
    >
      <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div class="min-w-0 space-y-0.5">
        <p class="text-sm font-medium">Full access</p>
        <p class="text-xs text-muted-foreground">
          {{ who }} can do anything with every resource, like cluster-admin. The details below rarely matter.
        </p>
      </div>
    </div>

    <div class="overflow-hidden rounded-xl border bg-card">
      <div
        :class="hasOther && 'with-other'"
        class="matrix-row h-8 items-center border-b border-border-subtle bg-surface-1/60 px-4 text-xs text-muted-foreground"
      >
        <span>Resource</span>
        <span v-for="verb in MATRIX_VERBS" :key="verb" class="text-center">{{ verb }}</span>
        <span class="pl-4">{{ hasOther ? "Also" : "" }}</span>
      </div>

      <section v-for="group in groups" :key="group.group" class="border-b border-border-subtle last:border-b-0">
        <button
          type="button"
          class="group/heading flex h-9 w-full items-center gap-2 px-4 text-left text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
          :aria-expanded="isOpen(group.group)"
          @click="toggle(closed, group.group)"
        >
          <ChevronRight
            class="h-3.5 w-3.5 shrink-0 transition-transform duration-fast ease-out"
            :class="isOpen(group.group) && 'rotate-90'"
          />
          <span class="text-foreground/80">{{ groupLabel(group.group) }}</span>
          <span class="font-normal tabular-nums">{{ group.visibleRows.length }}</span>
        </button>

        <div v-if="isOpen(group.group)" class="pb-1.5">
          <template v-for="row in rowsOf(group)" :key="row.key">
            <div
              :class="[hasOther && 'with-other', expanded.has(row.key) && 'bg-accent/50']"
              class="matrix-row cursor-default items-center px-4 py-1.5 transition-colors duration-fast hover:bg-accent/50"
              :role="expandable ? 'button' : undefined"
              :tabindex="expandable ? 0 : undefined"
              :aria-expanded="expandable ? expanded.has(row.key) : undefined"
              @click="expandable && toggle(expanded, row.key)"
              @keydown.enter.prevent="expandable && toggle(expanded, row.key)"
              @keydown.space.prevent="expandable && toggle(expanded, row.key)"
            >
              <div class="indent min-w-0">
                <p class="truncate text-sm">
                  <span :class="row.resource.startsWith('*') ? 'text-foreground/90' : 'text-foreground'">{{ resourceText(row.resource).main }}</span>
                  <span v-if="resourceText(row.resource).sub" class="text-muted-foreground">{{ resourceText(row.resource).sub }}</span>
                </p>
                <p v-if="row.names.length" class="truncate text-xs text-muted-foreground" :title="row.names.join(', ')">
                  Only {{ joinWords(row.names) }}
                </p>
              </div>
              <span v-for="verb in MATRIX_VERBS" :key="verb" class="flex justify-center" :title="dotTitle(row, verb)">
                <span v-if="rowGrants(row, verb)" class="h-2 w-2 rounded-full bg-success" />
                <span v-else class="h-1 w-1 rounded-full bg-muted-foreground/30" />
                <span class="sr-only">{{ rowGrants(row, verb) ? "allowed" : "not allowed" }}</span>
              </span>
              <span class="truncate pl-4 text-xs text-muted-foreground" :title="otherVerbs(row).join(', ') || undefined">
                {{ row.all ? "every other verb" : otherVerbs(row).join(", ") }}
              </span>
            </div>
            <div v-if="expanded.has(row.key)" class="indent-row space-y-1.5 bg-accent/50 pb-3 pr-4">
              <div v-for="(source, index) in row.sources" :key="index" class="min-w-0">
                <slot name="source" :source="source" :verbs="verbsOfSource(row, source)" />
              </div>
            </div>
          </template>
          <button
            v-if="!q && !showAll.has(group.group) && group.visibleRows.length > ROW_LIMIT"
            type="button"
            class="indent-row mt-0.5 rounded pr-1 text-xs font-medium text-link hover:underline focus-ring"
            @click="showAll.add(group.group)"
          >
            Show {{ group.visibleRows.length - ROW_LIMIT }} more
          </button>
        </div>
      </section>

      <section v-if="urls.length">
        <button
          type="button"
          class="flex h-9 w-full items-center gap-2 px-4 text-left text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
          :aria-expanded="isOpen('@urls')"
          @click="toggle(closed, '@urls')"
        >
          <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform duration-fast ease-out" :class="isOpen('@urls') && 'rotate-90'" />
          <span class="text-foreground/80">URL paths</span>
          <span class="font-normal">not resources: health checks, metrics, discovery</span>
          <span class="font-normal tabular-nums">{{ urls.length }}</span>
        </button>
        <div v-if="isOpen('@urls')" class="pb-1.5">
          <div v-for="row in urls" :key="row.path" class="indent-row flex h-8 items-center gap-4 pr-4 text-sm">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ row.path === "*" ? "Every URL path" : row.path }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ row.all ? "every verb" : joinWords([...row.verbs]) }}</span>
          </div>
        </div>
      </section>

      <p v-if="!groups.length && !urls.length" class="px-4 py-8 text-center text-sm text-muted-foreground">
        {{ q ? "Nothing matches." : "No permissions." }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Columns: resource, the seven verbs, then "Also" when needed. Kept out of
   the utility classes, which all ship in the startup CSS. */
.matrix-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(7, 2.75rem) 1rem;
}
.matrix-row.with-other {
  grid-template-columns: minmax(0, 1fr) repeat(7, 2.75rem) 8rem;
}
/* Rows line up with their group's name, past the chevron. */
.indent {
  padding-left: 1.375rem;
}
.indent-row {
  padding-left: 2.375rem;
}
</style>
