<script setup lang="ts">
defineOptions({ inheritAttrs: false });
import { Layers } from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { isProblem, type AppGroup } from "@/lib/clusterGraph";
import { GraphViewStateKey } from "./graphState";

/*
 * Background box of an application group: name, namespace and a health
 * summary. Not interactive itself (clicks go to the pane).
 */
const props = defineProps<{
  id: string;
  data: {
    group: AppGroup;
    pods: number;
    problems: number;
    members: string[];
    /** Member cards (relative to the group) for the overview zoom. */
    blocks: {
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      health: string;
    }[];
  };
}>();

const state = injectStrict(GraphViewStateKey);

const group = computed(() => props.data.group);
const isApp = computed(() => group.value.type === "app");
const title = computed(() =>
  group.value.type === "shared"
    ? "Shared"
    : group.value.type === "unused"
      ? "Unreferenced"
      : group.value.name
);
const dimmed = computed(() => {
  const lit = state.lit.value;
  if (lit) return !props.data.members.some((id) => lit.nodes.has(id));
  const matches = state.matches.value;
  if (matches) return !props.data.members.some((id) => matches.has(id));
  if (state.problems.value) return !isProblem(group.value.health);
  return false;
});

/* Overview zoom: member cards are blocks in their health colour. */
const BLOCK: Record<string, string> = {
  ok: "border-success/40 bg-success/20",
  warning: "border-warning/60 bg-warning/35",
  error: "border-destructive/70 bg-destructive/45",
  neutral: "border-border-strong bg-muted",
};

const DOT: Record<string, string> = {
  ok: "bg-success",
  neutral: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

const accent = computed(() => {
  if (group.value.health === "error") {
    return "shadow-[inset_0_2px_0_0_hsl(var(--destructive)/0.85)]";
  }
  if (group.value.health === "warning") {
    return "shadow-[inset_0_2px_0_0_hsl(var(--warning)/0.85)]";
  }
  return "";
});
</script>

<template>
  <div
    :class="[
      'graph-group relative h-full w-full rounded-xl border transition-opacity duration-base ease-out',
      isApp ? 'bg-surface-1/70' : 'border-dashed bg-surface-1/30',
      accent,
      dimmed && 'opacity-40',
    ]"
  >
    <template v-if="state.overview.value">
      <span
        v-for="block in data.blocks"
        :key="block.id"
        :class="['absolute rounded-lg border', BLOCK[block.health]]"
        :style="{
          left: `${block.x}px`,
          top: `${block.y}px`,
          width: `${block.width}px`,
          height: `${block.height}px`,
        }"
      />
    </template>
    <div
      v-if="state.overview.value"
      class="graph-group__overview pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-2"
    >
      <span
        class="graph-group__overview-title flex min-w-0 items-center gap-[0.35em] rounded-md bg-background/80 px-[0.4em] font-semibold text-foreground"
      >
        <span
          :class="['h-[0.55em] w-[0.55em] shrink-0 rounded-full', DOT[group.health]]"
        />
        <span class="truncate">{{ title }}</span>
      </span>
    </div>
    <div
      v-else
      class="graph-group__header flex h-10 min-w-0 items-center gap-2 px-3.5"
    >
      <span
        v-if="isApp"
        :class="['h-2 w-2 shrink-0 rounded-full', DOT[group.health]]"
        role="img"
        :aria-label="group.health"
      />
      <Layers v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span
        :class="[
          'graph-group__title truncate text-sm',
          isApp
            ? 'font-semibold text-foreground'
            : 'font-medium text-muted-foreground',
        ]"
        :title="title"
        >{{ title }}</span
      >
      <span
        class="graph-group__meta ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground"
      >
        <span
          v-if="data.problems > 0"
          :class="
            group.health === 'error' ? 'text-destructive' : 'text-warning'
          "
          >{{ data.problems }} issue{{ data.problems === 1 ? "" : "s" }}</span
        >
        <span v-if="data.pods > 0"
          >{{ data.pods }} pod{{ data.pods === 1 ? "" : "s" }}</span
        >
      </span>
    </div>
  </div>
</template>
