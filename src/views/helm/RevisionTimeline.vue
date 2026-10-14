<script setup lang="ts">
import { GitCompareArrows, Undo2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status";
import { formatAge } from "@/components/tables/age";
import { formatDateTime } from "@/lib/utils";
import {
  changedValuePaths,
  describePaths,
  releaseStatus,
  type HelmRevision,
} from "@/lib/helm";

/*
 * A release's revisions as a vertical timeline, newest first: what
 * happened (helm's description), when, and what changed since the revision
 * before (chart version, values). Pick one to roll back to it, or two to
 * compare them.
 */
const props = defineProps<{
  revisions: HelmRevision[];
  current: number;
  /** Roll back is offered (not blocked by guardrails / status). */
  canRollBack: boolean;
}>();

const emit = defineEmits<{
  rollback: [revision: HelmRevision];
  compare: [newer: number, older: number, show: "values" | "manifest"];
}>();

const selected = ref<number[]>([]);

watch(
  () => props.revisions.map((r) => r.revision).join(","),
  () => {
    const known = new Set(props.revisions.map((r) => r.revision));
    selected.value = selected.value.filter((r) => known.has(r));
  }
);

const toggle = (revision: number) => {
  const list = selected.value;
  if (list.includes(revision)) {
    selected.value = list.filter((r) => r !== revision);
  } else {
    // Two at most: the newest pick replaces the older one.
    selected.value = [...list.slice(-1), revision];
  }
};

/* What changed since the revision before: chart version, then values. */
const changes = computed(() => {
  const result = new Map<number, { chart: string; values: string }>();
  props.revisions.forEach((revision, index) => {
    const before = props.revisions[index + 1];
    const chart =
      before && before.chartVersion && before.chartVersion !== revision.chartVersion
        ? `${before.chartVersion} → ${revision.chartVersion}`
        : revision.chartVersion;
    if (!before) {
      result.set(revision.revision, { chart, values: "" });
      return;
    }
    const paths = changedValuePaths(before.values, revision.values);
    result.set(revision.revision, {
      chart,
      values: paths.length ? `${describePaths(paths)} changed` : "same values",
    });
  });
  return result;
});

const pair = computed(() => {
  if (selected.value.length !== 2) return null;
  const [a, b] = [...selected.value].sort((x, y) => y - x);
  return { newer: a, older: b };
});

const single = computed(() =>
  selected.value.length === 1
    ? props.revisions.find((r) => r.revision === selected.value[0]) ?? null
    : null
);
</script>

<template>
  <div>
    <ol class="relative" aria-label="Revisions">
      <li
        v-for="(revision, index) in revisions"
        :key="revision.revision"
        class="relative pl-6"
      >
        <!-- the line -->
        <span
          v-if="index < revisions.length - 1"
          class="absolute left-2 top-4 h-full w-px bg-border-strong"
          aria-hidden="true"
        />
        <span class="absolute left-1 top-3">
          <StatusDot
            :tone="releaseStatus(revision.status).tone"
            :pulse="releaseStatus(revision.status).busy"
          />
        </span>
        <button
          type="button"
          class="mb-0.5 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-fast ease-out focus-ring"
          :class="
            selected.includes(revision.revision)
              ? 'border-primary/40 bg-primary/10'
              : 'border-transparent hover:bg-accent'
          "
          :aria-pressed="selected.includes(revision.revision)"
          @click="toggle(revision.revision)"
        >
          <span class="flex items-baseline gap-2">
            <span class="text-sm font-medium tabular-nums">#{{ revision.revision }}</span>
            <span
              v-if="revision.revision === current"
              class="rounded-full bg-muted px-1.5 text-2xs font-medium leading-4 text-muted-foreground"
              >Current</span
            >
            <span
              v-if="releaseStatus(revision.status).problem"
              class="text-xs"
              :class="releaseStatus(revision.status).tone === 'destructive' ? 'text-destructive' : 'text-warning'"
              >{{ releaseStatus(revision.status).label }}</span
            >
            <span
              class="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
              :title="revision.updated ? formatDateTime(new Date(revision.updated)) : undefined"
              >{{ formatAge(revision.updated) }}</span
            >
          </span>
          <span
            class="mt-0.5 block text-xs"
            :class="revision.status === 'failed' ? 'text-destructive' : 'text-foreground/90'"
            >{{ revision.description || "–" }}</span
          >
          <span class="mt-0.5 block truncate text-xs text-muted-foreground">
            {{ changes.get(revision.revision)?.chart }}<template v-if="changes.get(revision.revision)?.values"> · {{ changes.get(revision.revision)?.values }}</template>
          </span>
        </button>
      </li>
    </ol>

    <!-- What the selection can do -->
    <div
      v-if="pair || single"
      class="sticky bottom-2 mt-2 flex items-center gap-1.5 rounded-lg border bg-card/95 p-1.5 pl-3 shadow-md backdrop-blur-sm"
    >
      <template v-if="pair">
        <span class="mr-auto truncate text-xs text-muted-foreground"
          >Compare #{{ pair.older }} and #{{ pair.newer }}</span
        >
        <Button size="xs" variant="outline" @click="emit('compare', pair.newer, pair.older, 'values')">
          <GitCompareArrows class="h-3 w-3" /> Values
        </Button>
        <Button size="xs" variant="outline" @click="emit('compare', pair.newer, pair.older, 'manifest')">
          Manifests
        </Button>
      </template>
      <template v-else-if="single">
        <span class="mr-auto truncate text-xs text-muted-foreground">
          {{ single.revision === current ? "Pick another revision to compare" : `Revision #${single.revision}` }}
        </span>
        <template v-if="single.revision !== current">
          <Button size="xs" variant="outline" @click="emit('compare', current, single.revision, 'values')">
            <GitCompareArrows class="h-3 w-3" /> Compare with current
          </Button>
          <Button v-if="canRollBack" size="xs" variant="outline" @click="emit('rollback', single)">
            <Undo2 class="h-3 w-3" /> Roll back
          </Button>
        </template>
      </template>
    </div>
  </div>
</template>
