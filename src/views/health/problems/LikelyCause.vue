<script setup lang="ts">
/**
 * What most likely caused a problem: the newest change to the object, its
 * owners or what it uses, shortly before the problem started (the change
 * timeline answers, see @/lib/changes/cause). Quiet when nothing explains
 * it; the change opens in the panel.
 */
import { History } from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import { injectStrict, formatDateTime } from "@/lib/utils";
import { PanelProviderSetSidePanelComponentKey, PanelProviderStateKey } from "@/providers/PanelProvider";
import { likelyCause, type ChangeSummary } from "@/lib/changes/cause";
import { followRef } from "@/lib/resources/open";
import { ago, durationWords } from "@/lib/resources/format";
import { kubeTarget } from "@/lib/health/problems/evidence";
import type { Problem, Ref } from "@/lib/health/problems/model";

const props = defineProps<{ problem: Problem; object: Ref; now: number }>();
const emit = defineEmits<{ found: [cause: ChangeSummary | null] }>();

const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const loading = ref(true);
const cause = shallowRef<ChangeSummary | null>(null);

/* Asked once per problem: the cause doesn't change while the problem goes on. */
watch(
  () => props.problem.fingerprint,
  async (fingerprint) => {
    loading.value = true;
    const since = props.problem.firstSeen !== undefined ? new Date(props.problem.firstSeen).toISOString() : undefined;
    const answer = await likelyCause(kubeTarget(props.problem), props.object, since).catch(() => null);
    if (fingerprint !== props.problem.fingerprint) return;
    cause.value = answer;
    loading.value = false;
    emit("found", answer);
  },
  { immediate: true }
);

const timing = computed(() => {
  const change = cause.value;
  if (!change) return null;
  const at = Date.parse(change.at);
  const started = props.problem.firstSeen;
  const text =
    started !== undefined && at <= started ? `${durationWords(started - at)} before it started` : ago(at, props.now);
  return { text, title: formatDateTime(new Date(at)) };
});

const open = () => {
  const change = cause.value;
  if (change) void followRef(setSidePanel, sidePanel.value, { context: props.problem.context, kubeConfig: props.problem.kubeConfig }, change.object);
};
</script>

<template>
  <div aria-live="polite">
    <div v-if="loading" class="flex items-center gap-2.5 text-xs text-muted-foreground" aria-label="Looking at recent changes">
      <History class="h-3.5 w-3.5 shrink-0" />
      <Skeleton class="h-3 w-40" />
    </div>
    <div v-else-if="cause && timing" class="flex gap-2.5 rounded-lg border bg-surface-1 px-3 py-2.5">
      <History class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1 space-y-0.5">
        <p class="flex items-baseline justify-between gap-3 text-xs">
          <span class="font-medium text-muted-foreground">Probably caused by</span>
          <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="open">Open {{ cause.object.kind }}</button>
        </p>
        <p class="select-text text-sm text-foreground">{{ cause.summary }}</p>
        <p class="text-xs text-muted-foreground">
          <span :title="timing.title">{{ timing.text }}</span><template v-if="cause.by"> · by {{ cause.by }}</template>
        </p>
      </div>
    </div>
    <p v-else class="flex items-center gap-2.5 text-xs text-muted-foreground">
      <History class="h-3.5 w-3.5 shrink-0" />
      No recent change explains it.
    </p>
  </div>
</template>
