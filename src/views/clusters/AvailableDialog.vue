<script setup lang="ts">
/**
 * Clusters in your cloud accounts that aren't added yet (the hub's "new
 * clusters" prompt): pick the ones to add, or ignore the ones you don't
 * need. Ignored ones can be restored.
 */
import { ChevronRight, Loader2, RefreshCw } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG, WIZARD_LIST, WIZARD_ROW } from "@/components/wizard/wizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import type { CatalogCluster } from "@/lib/clusters/cloud";

const props = defineProps<{
  available: CatalogCluster[];
  ignored: CatalogCluster[];
  /** "Checking acme-staging · eu-west-1…" while the accounts are asked again. */
  discovering: string | null;
  busy: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{
  add: [clusters: CatalogCluster[]];
  ignore: [clusters: CatalogCluster[]];
  restore: [clusters: CatalogCluster[]];
  refresh: [];
}>();

const picked = reactive(new Set<string>());
/* Everything is picked when the dialog opens; new ones as they're found. */
watch(
  () => [open.value, props.available.map((c) => c.key).join("|")] as const,
  ([isOpen], previous) => {
    if (!isOpen) return;
    const before = new Set(previous?.[1]?.split("|") ?? []);
    if (!previous?.[0]) picked.clear();
    for (const cluster of props.available) if (!previous?.[0] || !before.has(cluster.key)) picked.add(cluster.key);
  },
  { immediate: true }
);
const chosen = computed(() => props.available.filter((c) => picked.has(c.key)));
const all = computed({
  get: () => (chosen.value.length === props.available.length ? true : chosen.value.length ? "indeterminate" : false),
  set: (on: boolean | "indeterminate") => {
    picked.clear();
    if (on === true) props.available.forEach((c) => picked.add(c.key));
  },
});
const showIgnored = ref(false);
const providers = computed(() => [...new Set([...props.available, ...props.ignored].map((c) => c.provider))]);
const where = (c: CatalogCluster) => [c.region, c.accountName ?? c.accountId, c.roleName].filter(Boolean).join(" · ");
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="WIZARD_DIALOG">
      <WizardHeader
        title="New in your cloud accounts"
        :description="
          available.length
            ? `${available.length} ${available.length === 1 ? 'cluster isn\'t' : 'clusters aren\'t'} added to JET Pilot yet.`
            : 'Every cluster in your accounts is added or ignored.'
        "
      >
        <template v-if="providers.length === 1" #icon>
          <ProviderMark :provider="providers[0]!" :size="22" />
        </template>
      </WizardHeader>

      <div :class="WIZARD_BODY">
        <div :class="WIZARD_LIST">
          <label v-if="available.length > 1" :class="[WIZARD_ROW, 'cursor-pointer py-1.5 text-xs text-muted-foreground hover:bg-transparent']">
            <Checkbox v-model:checked="all" aria-label="Select all" />
            {{ chosen.length }} of {{ available.length }} selected
          </label>
          <label v-for="cluster in available" :key="cluster.key" :class="[WIZARD_ROW, 'cursor-pointer']">
            <Checkbox
              :checked="picked.has(cluster.key)"
              :aria-label="`Add ${cluster.name}`"
              @update:checked="(on: boolean) => (on ? picked.add(cluster.key) : picked.delete(cluster.key))"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ cluster.name }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ where(cluster) }}</span>
            </span>
            <span v-if="cluster.status && cluster.status !== 'ACTIVE'" class="flex items-center gap-1.5 text-xs text-warning">
              <span class="h-1.5 w-1.5 rounded-full bg-current" /> {{ cluster.status.charAt(0) + cluster.status.slice(1).toLowerCase() }}
            </span>
            <span v-else-if="cluster.version" class="font-mono text-xs tabular-nums text-muted-foreground">v{{ cluster.version }}</span>
          </label>

          <template v-if="ignored.length">
            <button
              type="button"
              class="mt-2 flex h-8 w-full items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground"
              :aria-expanded="showIgnored"
              @click="showIgnored = !showIgnored"
            >
              <ChevronRight class="h-3.5 w-3.5 transition-transform duration-fast" :class="showIgnored ? 'rotate-90' : ''" />
              Ignored ({{ ignored.length }})
            </button>
            <template v-if="showIgnored">
              <div v-for="cluster in ignored" :key="cluster.key" :class="[WIZARD_ROW, 'text-muted-foreground']">
                <span class="w-4" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ cluster.name }}</span>
                  <span class="block truncate text-xs">{{ where(cluster) }}</span>
                </span>
                <Button size="sm" variant="ghost" class="h-7" @click="emit('restore', [cluster])">Restore</Button>
              </div>
            </template>
          </template>
        </div>
      </div>

      <WizardFooter>
        <template #start>
          <Button variant="ghost" size="sm" class="-ml-2 min-w-0 text-muted-foreground" :disabled="!!discovering" @click="emit('refresh')">
            <RefreshCw class="h-3.5 w-3.5 shrink-0" :class="discovering ? 'animate-spin' : ''" />
            <span class="truncate">{{ discovering ?? "Look again" }}</span>
          </Button>
        </template>
        <Button variant="outline" :disabled="!chosen.length || busy" @click="emit('ignore', chosen)">Ignore</Button>
        <Button :disabled="!chosen.length || busy" @click="emit('add', chosen)">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          Add {{ chosen.length || "" }} {{ chosen.length === 1 ? "cluster" : "clusters" }}
        </Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
