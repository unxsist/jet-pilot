<script setup lang="ts">
/**
 * Sync an Argo CD application: what gets synced (source, revision, what
 * differs) and pruning as an explicit choice, since it deletes resources.
 * Protected clusters then ask for the typed confirmation (sync with prune
 * is destructive).
 */
import { RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { argoResources, argoSource } from "@/lib/gitops/model";
import { sync } from "@/lib/gitops/actions";

const props = defineProps<{ app: any }>();
const emit = defineEmits(["closeDialog"]);

const source = computed(() => argoSource(props.app));
const resources = computed(() => argoResources(props.app));
const differing = computed(() => resources.value.filter((r) => r.sync === "OutOfSync").length);
const extra = computed(() => (props.app.status?.resources ?? []).filter((r: any) => r.requiresPruning).length);
/* Pruning is part of the app's automated policy: start from it. */
const prune = ref(!!props.app.spec?.syncPolicy?.automated?.prune);

const summary = computed(() => {
  if (!differing.value) return "Nothing differs from Git right now; a sync applies it again.";
  return `${differing.value} ${differing.value === 1 ? "resource differs" : "resources differ"} from Git.`;
});

const run = () => {
  emit("closeDialog");
  void sync(props.app, { prune: prune.value });
};
</script>

<template>
  <div class="space-y-3">
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-surface-1 px-3 py-2.5 text-sm">
      <dt class="text-muted-foreground">Source</dt>
      <dd class="min-w-0 truncate" :title="source.url">{{ source.chart ?? source.repo ?? "–" }}</dd>
      <template v-if="source.path">
        <dt class="text-muted-foreground">Path</dt>
        <dd class="min-w-0 truncate">{{ source.path }}</dd>
      </template>
      <dt class="text-muted-foreground">Revision</dt>
      <dd>{{ source.ref || "HEAD" }}</dd>
    </dl>
    <p class="text-sm text-muted-foreground">{{ summary }}</p>
    <label class="flex cursor-pointer items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
      <span class="grid gap-0.5">
        <span class="text-sm font-medium">Prune</span>
        <span class="text-xs text-muted-foreground">
          Delete resources that are no longer in Git{{ extra ? ` (${extra} now)` : "" }}.
        </span>
      </span>
      <Switch v-model:checked="prune" class="mt-0.5" aria-label="Prune" />
    </label>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button :variant="prune ? 'destructive' : 'default'" @click="run">
      <RefreshCw class="h-3.5 w-3.5" />
      {{ prune ? "Sync and prune" : "Sync" }}
    </Button>
  </AlertDialogFooter>
</template>
