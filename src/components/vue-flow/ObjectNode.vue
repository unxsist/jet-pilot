<script setup lang="ts">
import { ChevronDown, ChevronRight, History } from "lucide-vue-next";
import { statusDotClass } from "@/components/ui/status";
import { formatResourceKind, injectStrict } from "@/lib/utils";
import { kindIcon } from "@/lib/kindIcons";
import { isProblem, type TopoNode } from "@/lib/clusterGraph";
import HealthStrip from "./HealthStrip.vue";
import {
  CATEGORY_TILE,
  HEALTH_TONE,
  healthStrip,
  kindLabel,
  nodeSubtitle,
} from "./nodeStatus";
import {
  FLAG_ENTER,
  FLAG_LEAVE,
  FLAG_LIT,
  FLAG_MATCH,
  FLAG_SELECTED,
  GraphViewStateKey,
} from "./graphState";

/*
 * A Kubernetes object in the resource graph: kind icon, name, a kind
 * specific summary and its health. Workload roots also show their pods as
 * a health strip and can be expanded into ReplicaSets / Jobs / Pods.
 */
defineOptions({ inheritAttrs: false });

const props = defineProps<{
  id: string;
  data: { node: TopoNode };
}>();

const state = injectStrict(GraphViewStateKey);

const node = computed(() => props.data.node);
const compact = computed(() => node.value.category === "pod");
const isRoot = computed(
  () => node.value.category === "workload" && !node.value.external
);
const showStrip = computed(
  () => node.value.category === "workload" && !!(node.value.pods || node.value.jobs)
);
const subtitle = computed(() => nodeSubtitle(node.value));
const strip = computed(() => (showStrip.value ? healthStrip(node.value) : []));
const tone = computed(() =>
  node.value.health === "neutral" ? null : HEALTH_TONE[node.value.health]
);
const icon = computed(() =>
  kindIcon(formatResourceKind(node.value.kind).toLowerCase())
);
const expanded = computed(() => state.expanded.value.has(props.id));
const oldCount = computed(() => node.value.replicaSets?.old.length || 0);
const childCount = computed(
  () =>
    (node.value.pods?.length || 0) +
    (node.value.replicaSets?.active.length || 0) +
    (node.value.jobs?.length || 0)
);
const stripLabel = computed(() => {
  if (node.value.kind === "CronJob") {
    const runs = node.value.jobs?.length || 0;
    return runs === 0 ? "no runs yet" : `${runs} run${runs === 1 ? "" : "s"}`;
  }
  const pods = node.value.pods?.length || 0;
  return pods === 0 ? "no pods" : `${pods} pod${pods === 1 ? "" : "s"}`;
});

/*
 * Highlighting: this card's own flags (selected, in the selected path,
 * search match, entering / leaving); dimming everything else is one class
 * on the canvas (see ClusterOverview.vue), so a selection only re-renders
 * the cards whose flags changed.
 */
const flags = state.flags.of(props.id);
const problem = computed(
  () => !!node.value.missing || isProblem(node.value.health)
);

const accent = computed(() => {
  if (node.value.missing) return "";
  if (node.value.health === "error") {
    return "shadow-[inset_3px_0_0_0_hsl(var(--destructive)),var(--shadow-xs)]";
  }
  if (node.value.health === "warning") {
    return "shadow-[inset_3px_0_0_0_hsl(var(--warning)),var(--shadow-xs)]";
  }
  return "shadow-xs";
});
</script>

<template>
  <!--
    Classes are plain arrays (no tailwind-merge): cards are mounted by the
    hundred while zooming, every microsecond per card counts.
  -->
  <div
    :class="[
      'graph-card relative flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border text-left text-foreground',
      accent,
      node.missing
        ? 'border-dashed border-destructive/70 bg-destructive/[0.04]'
        : 'bg-card',
      node.external && 'border-dashed',
      problem && 'is-problem',
      flags & FLAG_SELECTED && 'is-selected',
      flags & FLAG_LIT && 'is-lit',
      flags & FLAG_MATCH && 'is-match',
      flags & FLAG_ENTER && 'graph-card--enter',
      flags & FLAG_LEAVE && 'graph-card--leave',
    ]"
    :data-health="node.health"
  >
    <div
      :class="[
        'flex min-w-0 items-center',
        compact ? 'gap-2 px-2' : 'gap-2.5 px-2.5',
        showStrip && 'pt-1',
      ]"
    >
      <span
        :class="[
          'flex shrink-0 items-center justify-center rounded-md',
          compact ? 'h-6 w-6' : 'h-8 w-8',
          node.missing
            ? 'bg-destructive/10 text-destructive'
            : CATEGORY_TILE[node.category],
        ]"
      >
        <component
          :is="icon"
          :class="compact ? 'h-3.5 w-3.5' : 'h-4 w-4'"
          :stroke-width="1.75"
          aria-hidden="true"
        />
      </span>
      <div class="min-w-0 flex-1">
        <div
          :class="[
            'graph-card__name truncate font-medium leading-5',
            compact ? 'text-xs' : 'text-sm',
            node.missing && 'text-destructive',
          ]"
          :title="node.name"
        >
          {{ node.name }}
        </div>
        <div
          :class="[
            'graph-card__meta truncate leading-4 text-muted-foreground',
            compact ? 'text-2xs' : 'text-xs',
          ]"
        >
          <template v-if="node.missing || compact">{{ subtitle }}</template>
          <template v-else-if="subtitle.startsWith(node.kind)">
            <span class="font-medium text-foreground/80">{{
              kindLabel(node.kind)
            }}</span
            >{{ subtitle.slice(node.kind.length) }}
          </template>
          <template v-else>
            <span class="font-medium text-foreground/80">{{
              kindLabel(node.kind)
            }}</span>
            · {{ subtitle }}
          </template>
        </div>
      </div>
      <span
        v-if="node.missing"
        class="shrink-0 rounded-sm border border-destructive/30 bg-destructive/10 px-1 text-2xs font-medium uppercase tracking-wide text-destructive"
        >Missing</span
      >
      <span
        v-else-if="tone"
        class="graph-card__dot relative inline-flex h-2 w-2 shrink-0"
        role="img"
        :aria-label="node.health"
      >
        <span
          v-if="node.health === 'error'"
          :class="[
            'graph-ping absolute inset-0 rounded-full opacity-60 animate-status-ping',
            statusDotClass[tone],
          ]"
        />
        <span
          :class="[
            'relative inline-flex h-full w-full rounded-full',
            statusDotClass[tone],
          ]"
        />
      </span>
    </div>

    <div
      v-if="showStrip"
      class="mt-2 flex min-w-0 items-center gap-2 border-t border-border-subtle px-2.5 pt-1.5"
    >
      <HealthStrip :segments="strip" class="min-w-0 flex-1" />
      <span
        class="graph-card__meta shrink-0 text-2xs tabular-nums text-muted-foreground"
        >{{ stripLabel }}</span
      >
      <button
        v-if="isRoot && expanded && oldCount > 0"
        type="button"
        :class="[
          'nodrag nopan inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-2xs transition-colors duration-fast hover:bg-accent hover:text-foreground',
          state.history.value.has(id)
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground',
        ]"
        :title="`${state.history.value.has(id) ? 'Hide' : 'Show'} ${oldCount} old ReplicaSet${oldCount === 1 ? '' : 's'}`"
        :aria-pressed="state.history.value.has(id)"
        @click.stop="state.toggleHistory(id)"
      >
        <History class="h-3 w-3" />{{ oldCount }}
      </button>
      <button
        v-if="isRoot && childCount > 0"
        type="button"
        class="nodrag nopan -mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
        :title="expanded ? 'Collapse' : 'Expand pods'"
        :aria-label="expanded ? 'Collapse' : 'Expand pods'"
        :aria-expanded="expanded"
        @click.stop="state.toggleExpanded(id)"
      >
        <ChevronDown v-if="expanded" class="h-3.5 w-3.5" />
        <ChevronRight v-else class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
