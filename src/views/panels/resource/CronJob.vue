<script setup lang="ts">
/**
 * A cron job: its schedule in words (and time zone), the next run, how the
 * last runs went (recent jobs, linked) and Trigger now.
 */
import { useRouter } from "vue-router";
import { CalendarClock, History, Play } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { formatDateTime, injectStrict } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { describeCron, nextCronRun, isTimeZone } from "@/lib/resources/cron";
import { ago, between, fromNow, toMs } from "@/lib/resources/format";
import { openInPanel } from "@/lib/resources/open";
import { objectState } from "@/lib/resources/state";
import { actions as cronJobActions } from "@/actions/cronjobs";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();
const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const timeZone = computed(() => spec.value.timeZone as string | undefined);
const words = computed(() => describeCron(spec.value.schedule ?? ""));
const next = computed(() =>
  spec.value.suspend ? null : nextCronRun(spec.value.schedule ?? "", now.value, timeZone.value || "UTC")
);
const localTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const CONCURRENCY: Record<string, string> = {
  Allow: "Runs may overlap",
  Forbid: "Skips a run while the last one is still going",
  Replace: "A new run replaces one that is still going",
};

/* ------------------------------------------------------------ jobs -- */

const { items: jobs } = useRelatedList(
  () => "Job",
  () => target.value,
  () => (props.resource.metadata?.namespace ? [props.resource.metadata.namespace] : null)
);
const recent = computed(() =>
  jobs.value
    .filter((job: any) => (job.metadata?.ownerReferences ?? []).some((o: any) => o.uid === props.resource.metadata?.uid))
    .sort((a: any, b: any) => (toMs(b.metadata?.creationTimestamp) ?? 0) - (toMs(a.metadata?.creationTimestamp) ?? 0))
    .slice(0, 6)
    .map((job: any) => ({ job, state: objectState(job, now.value)! }))
);

/* -------------------------------------------------------- trigger -- */

const readOnly = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});
const trigger = cronJobActions(
  injectStrict(PanelProviderAddTabKey),
  injectStrict(DialogProviderSpawnDialogKey),
  setSidePanel,
  useRouter()
)[0] as { handler: (row: any) => void } | undefined;
</script>

<template>
  <PanelSection value="overview" title="Schedule" :icon="CalendarClock">
    <div class="space-y-3">
      <div>
        <div class="text-base font-medium leading-6">{{ words ?? "Custom schedule" }}</div>
        <div class="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span class="font-mono select-text">{{ spec.schedule }}</span>
          <span>·</span>
          <span v-if="timeZone">{{ timeZone }}<template v-if="!isTimeZone(timeZone)"> (unknown time zone)</template></span>
          <span v-else title="Without spec.timeZone the controller's own time zone counts">the controller's time zone (usually UTC)</span>
        </div>
      </div>
      <FactList>
        <Fact label="Next run">
          <template v-if="spec.suspend"><span class="text-muted-foreground">None: suspended</span></template>
          <template v-else-if="next">
            {{ fromNow(next, now) }}
            <span class="text-xs text-muted-foreground"> · {{ localTime(next) }}</span>
          </template>
          <span v-else class="text-muted-foreground">Never (the schedule doesn't match a date)</span>
        </Fact>
        <Fact v-if="status.lastScheduleTime" label="Last run" :title="formatDateTime(new Date(status.lastScheduleTime))">
          {{ ago(status.lastScheduleTime, now) }}
        </Fact>
        <Fact label="Last success">
          <span v-if="status.lastSuccessfulTime" :title="formatDateTime(new Date(status.lastSuccessfulTime))">{{
            ago(status.lastSuccessfulTime, now)
          }}</span>
          <span v-else class="text-muted-foreground">Not yet</span>
        </Fact>
        <Fact label="Overlap" :value="CONCURRENCY[spec.concurrencyPolicy ?? 'Allow']" />
      </FactList>
      <Button
        variant="outline"
        size="xs"
        :disabled="!!readOnly || !trigger"
        :title="readOnly || 'Create a job from it now, outside the schedule'"
        @click="trigger?.handler(resource)"
      >
        <Play class="h-3 w-3" /> Trigger now
      </Button>
    </div>
  </PanelSection>

  <PanelSection value="jobs" title="Recent runs" :icon="History" :count="recent.length">
    <ul v-if="recent.length">
      <li v-for="{ job, state } in recent" :key="job.metadata?.uid">
        <button
          type="button"
          class="flex h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/60 focus-ring focus-visible:ring-offset-card"
          :title="state.detail ?? `Open ${job.metadata?.name}`"
          @click="openInPanel(setSidePanel, sidePanel, job)"
        >
          <StatusDot :tone="state.tone" size="sm" class="ml-[3px]" :label="state.label" />
          <span class="min-w-0 flex-1 truncate">{{ ago(job.metadata?.creationTimestamp, now) }}</span>
          <span
            v-if="state.tone === 'destructive' || state.tone === 'info'"
            class="shrink-0 text-xs"
            :class="statusTextClass[state.tone]"
            >{{ state.label }}</span
          >
          <span v-else class="shrink-0 text-xs tabular-nums text-muted-foreground">{{
            between(job.status?.startTime, job.status?.completionTime) || state.label
          }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="text-xs text-muted-foreground">No runs kept. Jobs show here after the next run.</p>
  </PanelSection>
</template>
