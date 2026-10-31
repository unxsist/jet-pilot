<script setup lang="ts">
/**
 * The latest changes of a side panel's object on a timeline rail, like
 * its events: what changed in words, who and how long ago. A change of
 * something it depends on names that object first. A click opens the diff
 * or follows to the object.
 */
import { useRouter } from "vue-router";
import { ArrowRight } from "lucide-vue-next";
import { StatusDot } from "@/components/ui/status";
import { usePanelTarget } from "@/composables/usePanelObject";
import { injectStrict, formatDateTime } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { ago } from "@/lib/resources/format";
import { objectHistory } from "@/lib/changes/history";
import { managerLabel } from "@/lib/changes/words";
import type { Change } from "@/lib/changes/model";
import { openChange } from "./openChange";

const props = defineProps<{ object: any }>();

const SHOWN = 6;
/* The panel has its own events and container restarts. */
const HIDDEN = new Set(["event", "crash"]);

const router = useRouter();
const addTab = injectStrict(PanelProviderAddTabKey);
const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const target = usePanelTarget(() => props.object);

const self = {
  kind: props.object.kind,
  name: props.object.metadata?.name,
  namespace: props.object.metadata?.namespace || undefined,
};

let changes: Change[] = [];
try {
  changes = (await objectHistory(target.value, self, { chain: self.kind === "Pod" })).filter((c) => !HIDDEN.has(c.kind));
} catch {
  // No history is the honest fallback: the panel stays useful without it.
}
const shown = changes.slice(0, SHOWN);

const isSelf = (change: Change) =>
  change.object.kind === self.kind && change.object.name === self.name && (change.object.namespace ?? "") === (self.namespace ?? "");

const showAll = () => router.push({ path: "/health", query: { tab: "changes", q: self.name } });
</script>

<template>
  <div v-if="shown.length" class="space-y-3">
    <ol class="relative space-y-1">
      <span v-if="shown.length > 1" class="absolute bottom-3 left-[3px] top-3 w-px bg-border" aria-hidden="true" />
      <li v-for="change in shown" :key="change.key" class="relative flex gap-2">
        <StatusDot :tone="change.tone ?? 'muted'" class="mt-[7px] rounded-full ring-4 ring-card" />
        <button
          type="button"
          class="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left transition-colors duration-fast hover:bg-accent/60 focus-ring focus-visible:ring-offset-card"
          :title="change.diff ? 'Show the diff' : `Open ${change.object.name}`"
          @click="openChange(addTab, setSidePanel, sidePanel, change)"
        >
          <span class="block min-w-0">
            <span class="block truncate text-sm">
              <span v-if="!isSelf(change)" class="font-medium">{{ change.object.name }}: </span>{{ change.summary }}
            </span>
            <span class="block text-xs text-muted-foreground" :title="formatDateTime(new Date(change.at))">
              <template v-if="change.by">{{ managerLabel(change.by) }} · </template>{{ ago(change.at) }}
            </span>
          </span>
        </button>
      </li>
    </ol>
    <button
      type="button"
      class="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
      @click="showAll"
    >
      All changes <ArrowRight class="h-3 w-3" />
    </button>
  </div>
  <p v-else class="text-xs text-muted-foreground">No changes to {{ self.name }} in the last two weeks.</p>
</template>
