<script setup lang="ts">
/**
 * One change on the timeline, on one line: what changed (its kind's icon
 * and name), how in words, who made it and when. Changes made to the
 * cluster lead; what happened in it (a crash, a warning, a node condition)
 * stays a step quieter, with a small dot in its tone when it's a problem.
 * The cluster shows only when several are active. Clicking opens the diff
 * or the object; with a diff, the object is a hover away.
 */
import { PanelRight } from "lucide-vue-next";
import KindIcon from "@/components/KindIcon.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status";
import { cn, formatDateTime } from "@/lib/utils";
import { isSymptom, timeOfDay, type Change } from "@/lib/changes/model";
import { managerLabel } from "@/lib/changes/words";
import { canOpenObject } from "./openChange";

const props = defineProps<{
  change: Change;
  /** Several clusters are active: say which one it's in. */
  showContext: boolean;
  focused: boolean;
}>();

const emit = defineEmits<{ open: []; openObject: []; focus: [] }>();

const SOURCES: Record<Change["source"], string> = {
  recorded: "Recorded live while JET Pilot was open",
  revisions: "From the rollout history",
  helm: "From the Helm release history",
  argocd: "From the Argo CD sync history",
  flux: "From the Flux status",
  "managed-fields": "From the object's managed fields",
  pods: "From the pod's last restart",
  nodes: "From the node's conditions",
  events: "From the cluster's events",
};

const KIND_ICONS: Record<string, string> = { HelmRelease: "helm", Application: "gitops", Kustomization: "gitops" };

const icon = computed(() => KIND_ICONS[props.change.object.kind] ?? props.change.object.kind);
const when = computed(() => {
  const date = new Date(props.change.at);
  const source = props.change.recorded ? SOURCES.recorded : SOURCES[props.change.source];
  return { text: timeOfDay(props.change.at), title: `${formatDateTime(date)}\n${source}` };
});
const where = computed(() =>
  [props.change.object.kind, props.change.object.namespace, props.showContext ? props.change.target.context : ""]
    .filter(Boolean)
    .join(" · ")
);
const by = computed(() => managerLabel(props.change.by));
const openable = computed(() => !!props.change.diff && canOpenObject(props.change));
const symptom = computed(() => isSymptom(props.change));
</script>

<template>
  <div
    role="row"
    :tabindex="focused ? 0 : -1"
    :data-change-key="change.key"
    :class="
      cn(
        'group/row flex h-10 cursor-default items-center gap-3 rounded-lg px-3 outline-none transition-colors duration-fast ease-out',
        'hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring'
      )
    "
    @focusin="emit('focus')"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
  >
    <KindIcon :name="icon" :class="cn('h-4 w-4', symptom ? 'text-muted-foreground/60' : 'text-muted-foreground')" />
    <div class="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
      <span
        :class="cn('max-w-[50%] shrink-0 truncate', symptom ? 'text-muted-foreground' : 'font-medium text-foreground')"
        :title="`${change.object.name}\n${where}`"
      >
        {{ change.object.name }}
      </span>
      <StatusDot v-if="change.tone" :tone="change.tone" class="shrink-0" />
      <span
        :class="cn('min-w-0 truncate', symptom ? 'text-muted-foreground' : 'text-foreground/80')"
        :title="change.summary"
        >{{ change.summary }}</span
      >
    </div>

    <!-- With a diff the click shows it; the object is one more click away. -->
    <Button
      v-if="openable"
      variant="ghost"
      size="icon-sm"
      class="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100"
      :aria-label="`Open ${change.object.name}`"
      :title="`Open ${change.object.name}`"
      @click.stop="emit('openObject')"
    >
      <PanelRight class="h-3.5 w-3.5" />
    </Button>
    <span class="w-28 shrink-0 truncate text-right text-xs text-muted-foreground" :title="change.by">{{ by }}</span>
    <ContextAvatar
      v-if="showContext"
      :name="change.target.context"
      :kube-config="change.target.kubeConfig"
      size="sm"
      :title="change.target.context"
    />
    <span class="w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground" :title="when.title">{{
      when.text
    }}</span>
  </div>
</template>
