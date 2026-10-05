<script setup lang="ts">
/**
 * The clusters a cloud account has, while JET Pilot looks for them and
 * after: pick the ones to add (new ones are picked as they turn up), see
 * what couldn't be checked, and choose a folder. Used by every
 * cloud-connect flow.
 */
import { ChevronRight, Loader2 } from "lucide-vue-next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { WIZARD_LIST, WIZARD_ROW } from "@/components/wizard/wizard";
import type { CatalogCluster } from "@/lib/clusters/cloud";
import { catalogStatus, catalogWhere, failureSummary, type failureGroups } from "@/lib/clusters/cloudModel";

const props = defineProps<{
  clusters: CatalogCluster[];
  discovering: boolean;
  /** "acme-staging · eu-north-1" while it's being checked. */
  checking: string | null;
  failures: ReturnType<typeof failureGroups>;
  folders?: string[];
  emptyTitle: string;
  emptyHint: string;
}>();
const selected = defineModel<string[]>("selected", { required: true });
const folder = defineModel<string>("folder", { required: true });

const picked = computed(() => new Set(selected.value));
const selectable = computed(() => props.clusters.filter((c) => c.state !== "added" && c.state !== "removed"));
const chosen = computed(() => selectable.value.filter((c) => picked.value.has(c.key)));
const toggle = (key: string, on: boolean) => {
  const next = new Set(picked.value);
  if (on) next.add(key);
  else next.delete(key);
  selected.value = [...next];
};
const setAll = (on: boolean) => (selected.value = on ? selectable.value.map((c) => c.key) : []);

/* New clusters are picked as they turn up (not ones already added or ignored). */
watch(
  () => props.clusters,
  (list, previous) => {
    const before = new Set((previous ?? []).map((c) => c.key));
    const fresh = list.filter((c) => !before.has(c.key) && c.state === "available").map((c) => c.key);
    if (fresh.length) selected.value = [...new Set([...selected.value, ...fresh])];
  },
  { immediate: true }
);

const statusOf = catalogStatus;
const showFailures = ref(false);
</script>

<template>
  <div>
    <div v-if="discovering" class="mb-3 flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
      <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span class="truncate">
        <template v-if="checking">Checking {{ checking }} · </template>
        {{ clusters.length }} {{ clusters.length === 1 ? "cluster" : "clusters" }} so far
      </span>
    </div>

    <div v-if="clusters.length" :class="WIZARD_LIST">
      <label
        v-if="selectable.length > 1"
        class="sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-3 bg-popover px-3 text-xs text-muted-foreground"
      >
        <Checkbox
          :checked="chosen.length === selectable.length ? true : chosen.length ? 'indeterminate' : false"
          aria-label="Select all clusters"
          @update:checked="(on: boolean) => setAll(on)"
        />
        <span class="tabular-nums">{{ chosen.length }} of {{ selectable.length }} selected</span>
      </label>
      <label
        v-for="cluster in clusters"
        :key="cluster.key"
        :class="[WIZARD_ROW, cluster.state === 'added' || cluster.state === 'removed' ? 'hover:bg-transparent' : 'cursor-pointer']"
      >
        <Checkbox
          :checked="cluster.state === 'added' || picked.has(cluster.key)"
          :disabled="cluster.state === 'added' || cluster.state === 'removed'"
          :aria-label="`Add ${cluster.name}`"
          @update:checked="(on: boolean) => toggle(cluster.key, on)"
        />
        <span class="min-w-0 flex-1" :class="cluster.state === 'added' ? 'opacity-60' : ''">
          <span class="block truncate text-sm font-medium">{{ cluster.name }}</span>
          <span class="block truncate text-xs text-muted-foreground">{{ catalogWhere(cluster) }}</span>
        </span>
        <span v-if="cluster.state === 'added'" class="text-xs text-muted-foreground">Already added</span>
        <span v-else-if="cluster.state === 'ignored'" class="text-xs text-muted-foreground">Ignored</span>
        <span v-else-if="statusOf(cluster)" class="flex items-center gap-1.5 text-xs text-warning">
          <span class="h-1.5 w-1.5 rounded-full bg-current" /> {{ statusOf(cluster) }}
        </span>
        <span v-else-if="cluster.version" class="font-mono text-xs tabular-nums text-muted-foreground">
          v{{ cluster.version.replace(/^v/, "") }}
        </span>
      </label>
    </div>
    <div v-else-if="!discovering" class="rounded-xl bg-muted/50 px-6 py-8 text-center">
      <p class="text-sm font-medium">{{ emptyTitle }}</p>
      <p class="mt-1 text-xs text-muted-foreground">{{ emptyHint }}</p>
    </div>

    <div v-if="failures.length" class="mt-4 text-xs">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-sm text-warning focus-ring"
        :aria-expanded="showFailures"
        @click="showFailures = !showFailures"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-current" />
        {{ failureSummary(failures) }}
        <ChevronRight class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-fast" :class="showFailures ? 'rotate-90' : ''" />
      </button>
      <ul v-if="showFailures" class="mt-2 space-y-1 pl-3 text-muted-foreground">
        <li v-for="group in failures" :key="group.account">
          <span class="font-medium text-foreground">{{ group.account }}</span>
          <template v-if="group.regions.length"> ({{ group.regions.join(", ") }})</template>: {{ group.message }}
        </li>
      </ul>
    </div>

    <div v-if="selectable.length" class="mt-5 flex items-center gap-3">
      <label for="catalog-folder" class="text-sm text-muted-foreground">Folder</label>
      <Input id="catalog-folder" v-model="folder" class="h-8 w-60" list="catalog-folders" placeholder="No folder" spellcheck="false" />
      <datalist id="catalog-folders">
        <option v-for="name in folders ?? []" :key="name" :value="name" />
      </datalist>
    </div>
  </div>
</template>
