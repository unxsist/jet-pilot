<script setup lang="ts">
/**
 * Pods related to the panel's object (a node's, a Service's, a claim's), one
 * quiet line each: a dot, the name, and a word only when something is
 * wrong. Problems first; a click opens the pod in the panel.
 */
import { ChevronRight } from "lucide-vue-next";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { injectStrict } from "@/lib/utils";
import { PanelProviderSetSidePanelComponentKey, PanelProviderStateKey } from "@/providers/PanelProvider";
import { openInPanel } from "@/lib/resources/open";
import { podState } from "@/lib/resources/pod";

const props = withDefaults(
  defineProps<{
    pods: any[];
    now: number;
    limit?: number;
    /** Quiet text on the right of healthy pods (e.g. the namespace). */
    detail?: (pod: any) => string | undefined;
  }>(),
  { limit: 6, detail: undefined }
);

const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const RANK: Record<string, number> = { destructive: 0, warning: 1, info: 2 };

const rows = computed(() =>
  props.pods
    .map((pod) => ({ pod, state: podState(pod, props.now) }))
    .sort(
      (a, b) =>
        (RANK[a.state.tone] ?? 3) - (RANK[b.state.tone] ?? 3) ||
        String(a.pod.metadata?.name).localeCompare(String(b.pod.metadata?.name))
    )
);

const expanded = ref(false);
const shown = computed(() => (expanded.value ? rows.value : rows.value.slice(0, props.limit)));
const problem = (tone: string) => tone === "destructive" || tone === "warning";
</script>

<template>
  <div>
    <ul>
      <li v-for="{ pod, state } in shown" :key="pod.metadata?.uid ?? pod.metadata?.name">
        <button
          type="button"
          class="group/item flex h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/60 focus-ring focus-visible:ring-offset-card"
          :title="state.detail ?? `Open ${pod.metadata?.name}`"
          @click="openInPanel(setSidePanel, sidePanel, pod)"
        >
          <StatusDot :tone="state.tone" size="sm" class="ml-[3px]" :label="state.label" />
          <span class="min-w-0 flex-1 truncate">{{ pod.metadata?.name }}</span>
          <span v-if="problem(state.tone)" class="shrink-0 text-xs" :class="statusTextClass[state.tone]">{{
            state.label
          }}</span>
          <span v-else-if="detail?.(pod)" class="shrink-0 truncate text-xs text-muted-foreground">{{ detail(pod) }}</span>
          <ChevronRight
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/item:opacity-100"
          />
        </button>
      </li>
    </ul>
    <button
      v-if="rows.length > limit"
      type="button"
      class="ml-1.5 mt-0.5 text-xs text-link hover:underline"
      @click="expanded = !expanded"
    >
      {{ expanded ? "Show less" : `Show all ${rows.length}` }}
    </button>
  </div>
</template>
