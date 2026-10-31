<script setup lang="ts">
/**
 * The side panel of a problem: what's wrong in a sentence, what most likely
 * caused it, the fixes (with a word of warning when GitOps or Helm manages
 * the object), and the evidence folded below: the pods involved, the last
 * crash, the logs before it, the failing probe, memory against the limit
 * and recent warnings. Live: a fix that works shows as resolved.
 */
import { CalendarSearch, Boxes, FolderTree, MoreHorizontal, ScrollText, Skull, Sparkles, Stethoscope } from "lucide-vue-next";
import type { Component } from "vue";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import PanelSection from "@/components/generic/PanelSection.vue";
import StateSummary from "@/components/generic/StateSummary.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import LikelyCause from "./LikelyCause.vue";
import LogTail from "./LogTail.vue";
import WarningEvents from "./WarningEvents.vue";
import ManagedNotice from "./ManagedNotice.vue";
import { injectStrict, formatDateTime } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useAskAi } from "@/lib/ai/askAi";
import type { ChangeSummary } from "@/lib/changes/cause";
import { resolveCluster } from "@/lib/clusters/meta";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { objectState } from "@/lib/resources/state";
import { containerProbes } from "@/lib/resources/pod";
import { openInPanel } from "@/lib/resources/open";
import { ago, sentence } from "@/lib/resources/format";
import { hasUsage, type Subject } from "@/lib/metrics/usage";
import { useProblemFeed } from "@/lib/health/problems/feed";
import { podsWords } from "@/lib/health/problems/group";
import { fetchSubject, logFinding, logSource } from "@/lib/health/problems/evidence";
import { changeCanExplain, fixLabel, fixesFor, primaryFix, type FixId } from "@/lib/health/problems/fixes";
import { managedWords, managerOf, type Manager } from "@/lib/health/problems/managed";
import { SNOOZES, isActive, snooze, unsnooze } from "@/lib/health/problems/snooze";
import { askAbout, openLogs, openSubject } from "@/lib/health/problems/actions";
import { exitMeaning } from "@/lib/health/problems/words";
import { KINDS, type Problem } from "@/lib/health/problems/model";
import { runFix } from "./panel";

const props = defineProps<{ fingerprint: string; problem: Problem }>();

const UsageSection = defineAsyncComponent(() => import("@/components/metrics/UsageSection.vue"));

const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { settings } = injectStrict(SettingsContextStateKey);
const askAi = useAskAi();

const feed = useProblemFeed();
const now = feed.now;

/* Live while it lasts; the last known state once it's resolved. */
const live = computed(() => feed.problems.value.find((p) => p.fingerprint === props.fingerprint));
const resolved = computed(() => !live.value && !feed.loading.value);
const problem = computed(() => live.value ?? props.problem);
const primary = computed(() => problem.value.findings[0]!);

const cluster = computed(() => resolveCluster(settings.value.clusters, problem.value.context, problem.value.kubeConfig));
const readOnly = computed(() => {
  const guarded = guardedCluster(problem.value.context, problem.value.kubeConfig);
  return guarded.readOnly ? readOnlyReason(guarded) : "";
});

/* ----------------------------------------------------------- state -- */

/* The object the problem is about first: a pod, a node, the Job. */
const primaryObject = computed(() => feed.find(primary.value.object, problem.value.context));

const state = computed(() => {
  if (resolved.value) {
    return { label: "Resolved", tone: "success" as const, detail: "It isn't a problem anymore. This is how it last looked." };
  }
  const p = problem.value;
  const own = primaryObject.value ? objectState(primaryObject.value, now.value) : null;
  // Pods and nodes say it best themselves; the rest from the finding.
  const detail =
    own?.detail && ["Pod", "Node", "Job", "CronJob"].includes(primary.value.object.kind) && own.tone !== "success"
      ? own.detail
      : [`${primary.value.short}.`, primary.value.message && sentence(primary.value.message)].filter(Boolean).join(" ");
  return {
    label: p.label,
    tone: p.tone,
    detail,
    since: p.firstSeen !== undefined ? new Date(p.firstSeen).toISOString() : undefined,
  };
});

/* Other trouble of the same workload ("Rollout stuck" next to crashing pods), once per kind. */
const also = computed(() => {
  const seen = new Set([primary.value.kind]);
  return problem.value.findings.filter((f) => {
    if (seen.has(f.kind)) return false;
    seen.add(f.kind);
    return true;
  });
});

const lastSeen = computed(() => {
  const at = problem.value.lastSeen;
  return at !== undefined && now.value - at > 60_000 ? { text: `Last seen ${ago(at, now.value)}`, title: formatDateTime(new Date(at)) } : null;
});

/* ------------------------------------------------- managed + fixes -- */

const subject = shallowRef<any>(null);
const manager = shallowRef<Manager | null>(null);
watch(
  () => props.fingerprint,
  async () => {
    subject.value = null;
    manager.value = null;
    const object = await fetchSubject(problem.value).catch(() => null);
    subject.value = object;
    manager.value = managerOf(object);
  },
  { immediate: true }
);
const managed = computed(() => (manager.value ? managedWords(manager.value) : null));

const cause = shallowRef<ChangeSummary | null>(null);
const fixes = computed<FixId[]>(() => (resolved.value ? [] : fixesFor(problem.value)));
const leadFix = computed(() => (resolved.value ? null : primaryFix(problem.value, !!cause.value)));
/* The primary fix first; two buttons at most, the rest in the menu. */
const ordered = computed(() => (leadFix.value ? [leadFix.value, ...fixes.value.filter((f) => f !== leadFix.value)] : fixes.value));
const shownFixes = computed(() => ordered.value.slice(0, 2));
const moreFixes = computed(() => ordered.value.slice(2));
const doFix = (fix: FixId) => runFix(problem.value, fix, spawnDialog);

const source = computed(() => logSource(problem.value, feed.items("pods"), feed.items("jobs")));
const doLogs = () => source.value && openLogs(problem.value, source.value, addTab);

const causeObject = computed(() => logFinding(problem.value)?.object ?? primary.value.object);
const doAsk = () =>
  askAbout(problem.value, askAi, [
    ...(cause.value ? [`Likely cause: ${cause.value.summary} (${cause.value.at}${cause.value.by ? `, by ${cause.value.by}` : ""}).`] : []),
    ...(managed.value ? [`${managed.value.title}.`] : []),
  ]);

/* --------------------------------------------------------- snooze -- */

const snoozeEntry = computed(() =>
  (settings.value.snoozedProblems ?? []).find((s) => s.fingerprint === props.fingerprint && isActive(s, now.value))
);
const setSnooze = (ms?: number) => {
  settings.value.snoozedProblems = snooze(settings.value.snoozedProblems ?? [], props.fingerprint, Date.now(), ms);
};
const showAgain = () => {
  settings.value.snoozedProblems = unsnooze(settings.value.snoozedProblems ?? [], props.fingerprint);
};
const snoozedText = computed(() => {
  const entry = snoozeEntry.value;
  if (!entry) return "";
  return entry.until === undefined ? "Acknowledged: hidden until it's resolved." : `Snoozed until ${formatDateTime(new Date(entry.until))}.`;
});

/* -------------------------------------------------------- evidence -- */

/* Affected pods, the worst first, each with its live object to open. */
const pods = computed(() => {
  const seen = new Set<string>();
  return problem.value.findings.filter((f) => {
    if (f.object.kind !== "Pod" || seen.has(f.object.name)) return false;
    seen.add(f.object.name);
    return true;
  });
});
const showPods = computed(() => problem.value.subject.kind !== "Pod" && pods.value.length > 0);
const openPod = (finding: Problem["findings"][number]) => {
  const object = feed.find(finding.object, problem.value.context);
  if (object) openInPanel(setSidePanel, sidePanel.value, object);
};

/* The last crash of the container that tells the most. */
const termination = computed(() => {
  const finding = logFinding(problem.value);
  if (!finding || (finding.kind !== "crashloop" && finding.kind !== "oom")) return null;
  const pod = feed.find(finding.object, problem.value.context);
  const status = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])].find(
    (c: any) => c.name === finding.container
  );
  const ended = status?.state?.terminated ?? status?.lastState?.terminated;
  if (!ended) return null;
  return {
    container: finding.container,
    reason: ended.reason === "OOMKilled" ? "Out of memory (OOMKilled)" : (ended.reason ?? "Unknown"),
    exitCode: ended.exitCode as number | undefined,
    exitMeaning: exitMeaning(ended.exitCode),
    finished: ended.finishedAt ? { text: ago(ended.finishedAt, now.value), title: formatDateTime(new Date(ended.finishedAt)) } : null,
    restarts: status?.restartCount ?? 0,
    limit: finding.memoryLimit,
    message: ended.message?.trim(),
  };
});

/* The probe that doesn't pass, as configured, with what it answered. */
const probe = computed(() => {
  const finding = problem.value.findings.find((f) => f.kind === "probe" || /probe failing/.test(f.label ?? ""));
  if (!finding?.container) return null;
  const pod = feed.find(finding.object, problem.value.context);
  const container = pod?.spec?.containers?.find((c: any) => c.name === finding.container);
  const type = /^Liveness|^Startup/.test(finding.label ?? "") ? (finding.label!.split(" ")[0] as string) : "Readiness";
  const configured = container ? containerProbes(container).find((p) => p.type === type) : undefined;
  return { type, configured, answer: finding.message };
});

/* Memory against the limit: the workload's usage (or the pod's) over time. */
const usageSubject = computed<Subject | null>(() => {
  if (problem.value.kind !== "oom") return null;
  const object = hasUsage(problem.value.subject.kind) ? subject.value : primaryObject.value;
  return object && hasUsage(object.kind) ? object : null;
});

const eventObjects = computed(() => {
  const refs = [primary.value.object];
  if (problem.value.subject.name !== primary.value.object.name || problem.value.subject.kind !== primary.value.object.kind) refs.push(problem.value.subject);
  for (const f of problem.value.findings) if (f.object.kind !== "Pod" && !refs.some((r) => r.kind === f.object.kind && r.name === f.object.name)) refs.push(f.object);
  return refs;
});

const SECTION_ICONS: Record<string, Component> = { pods: Boxes, termination: Skull, logs: ScrollText, probe: Stethoscope, events: CalendarSearch };

const open = ref<string[]>([]);
watch(
  () => props.fingerprint,
  () => {
    const crash = ["oom", "crashloop", "cant-start"].includes(problem.value.kind);
    open.value = [
      ...(pods.value.length > 1 && !crash ? ["pods"] : []),
      ...(crash ? ["termination", "logs", "usage"] : []),
      ...(problem.value.kind === "job-failed" || problem.value.kind === "cronjob-failed" ? ["logs"] : []),
      ...(probe.value ? ["probe"] : []),
      ...(!crash ? ["events"] : []),
    ];
  },
  { immediate: true }
);
</script>

<template>
  <div :key="fingerprint" class="bg-card">
    <StateSummary :state="state" :now="now" />

    <div class="space-y-4 border-b px-4 pb-4 pt-3">
      <!-- Quiet facts: where, and how many -->
      <dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div v-if="problem.namespace" class="flex min-w-0 items-center gap-1.5">
          <dt class="sr-only">Namespace</dt>
          <FolderTree class="h-3 w-3 shrink-0" />
          <dd class="truncate">{{ problem.namespace }}</dd>
        </div>
        <div class="flex min-w-0 items-center gap-1.5">
          <dt class="sr-only">Cluster</dt>
          <ContextAvatar :name="problem.context" size="sm" class="h-4 w-4 text-[9px]" />
          <dd class="truncate" :title="problem.context">{{ cluster.displayName }}</dd>
        </div>
        <div v-if="lastSeen">
          <dt class="sr-only">Last seen</dt>
          <dd :title="lastSeen.title">{{ lastSeen.text }}</dd>
        </div>
      </dl>

      <ul v-if="also.length" class="space-y-1">
        <li v-for="finding in also" :key="finding.kind" class="flex min-w-0 items-center gap-2.5 text-xs">
          <span class="flex w-3.5 shrink-0 justify-center"><StatusDot :tone="KINDS[finding.kind].tone" size="sm" /></span>
          <span class="shrink-0 font-medium" :class="statusTextClass[KINDS[finding.kind].tone]">{{ finding.label ?? KINDS[finding.kind].label }}</span>
          <span class="truncate text-muted-foreground" :title="finding.message ?? finding.short">{{ finding.short }}</span>
        </li>
      </ul>

      <LikelyCause v-if="!resolved && changeCanExplain(problem)" :problem="problem" :object="causeObject" :now="now" @found="cause = $event" />

      <ManagedNotice v-if="manager && fixes.length" :manager="manager" quiet />

      <p v-if="snoozedText" class="text-xs text-muted-foreground">
        {{ snoozedText }}
        <button type="button" class="font-medium text-link hover:underline" @click="showAgain">Show again</button>
      </p>

      <!-- One primary action, the rest a step away -->
      <div class="flex flex-wrap items-center gap-1.5">
        <Button v-if="source && !leadFix" size="sm" @click="doLogs">
          <ScrollText class="h-3.5 w-3.5" />
          Logs
        </Button>
        <Button
          v-for="fix in shownFixes"
          :key="fix"
          :variant="fix === leadFix ? 'default' : 'outline'"
          size="sm"
          :disabled="!!readOnly"
          :title="readOnly || undefined"
          @click="doFix(fix)"
        >
          {{ fixLabel(fix, problem) }}
        </Button>
        <Button v-if="source && leadFix" variant="outline" size="sm" @click="doLogs">
          <ScrollText class="h-3.5 w-3.5" />
          Logs
        </Button>
        <Button v-if="!fixes.length && !source" variant="outline" size="sm" @click="openSubject(problem, setSidePanel, sidePanel)">
          Open {{ problem.subject.kind }}
        </Button>
        <Button v-if="askAi.available.value" variant="outline" size="sm" @click="doAsk">
          <Sparkles class="h-3.5 w-3.5" />
          Ask AI
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="More actions">
              <MoreHorizontal class="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-56">
            <template v-if="moreFixes.length">
              <DropdownMenuItem v-for="fix in moreFixes" :key="fix" :disabled="!!readOnly" @select="doFix(fix)">
                {{ fixLabel(fix, problem) }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </template>
            <DropdownMenuItem @select="openSubject(problem, setSidePanel, sidePanel)">Open {{ problem.subject.kind }}</DropdownMenuItem>
            <template v-if="!resolved">
              <DropdownMenuSeparator />
              <DropdownMenuItem v-if="snoozeEntry" @select="showAgain">Show again</DropdownMenuItem>
              <template v-else>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Snooze</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="w-40">
                    <DropdownMenuItem v-for="option in SNOOZES" :key="option.id" @select="setSnooze(option.ms)">
                      {{ option.label }}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem @select="setSnooze()">Acknowledge</DropdownMenuItem>
              </template>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <Accordion v-model="open" class="w-full" type="multiple" collapsible>
      <PanelSection v-if="showPods" value="pods" title="Pods" :icon="SECTION_ICONS.pods" :count="pods.length" :hint="podsWords(problem)">
        <ul class="-mx-2 space-y-px">
          <li v-for="finding in pods" :key="finding.object.name">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-fast hover:bg-accent/60"
              @click="openPod(finding)"
            >
              <StatusDot :tone="KINDS[finding.kind].tone" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ finding.object.name }}</span>
                <span class="block truncate text-xs text-muted-foreground">{{ finding.label ?? KINDS[finding.kind].label }} · {{ finding.short }}</span>
              </span>
            </button>
          </li>
        </ul>
      </PanelSection>

      <PanelSection v-if="termination" value="termination" title="Last crash" :icon="SECTION_ICONS.termination" :hint="termination.finished?.text">
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">Reason</dt>
          <dd>{{ termination.reason }}</dd>
          <template v-if="termination.exitCode !== undefined">
            <dt class="text-muted-foreground">Exit code</dt>
            <dd class="tabular-nums">
              {{ termination.exitCode }}<span v-if="termination.exitMeaning" class="text-muted-foreground"> · {{ termination.exitMeaning }}</span>
            </dd>
          </template>
          <template v-if="termination.limit">
            <dt class="text-muted-foreground">Memory limit</dt>
            <dd class="tabular-nums">{{ termination.limit }}</dd>
          </template>
          <template v-if="termination.finished">
            <dt class="text-muted-foreground">When</dt>
            <dd :title="termination.finished.title">{{ termination.finished.text }}</dd>
          </template>
          <dt class="text-muted-foreground">Restarts</dt>
          <dd class="tabular-nums">{{ termination.restarts }}</dd>
          <dt class="text-muted-foreground">Container</dt>
          <dd class="truncate">{{ termination.container }}</dd>
        </dl>
        <p v-if="termination.message" class="mt-3 select-text whitespace-pre-wrap break-words rounded-lg border bg-surface-1 px-3 py-2 font-mono text-2xs text-muted-foreground">{{ termination.message }}</p>
      </PanelSection>

      <PanelSection
        v-if="source"
        value="logs"
        :title="source.previous ? 'Logs before the crash' : 'Logs'"
        :icon="SECTION_ICONS.logs"
        :hint="source.container"
      >
        <LogTail :problem="problem" :source="source" @open="doLogs" />
      </PanelSection>

      <PanelSection v-if="probe" value="probe" :title="`${probe.type} probe`" :icon="SECTION_ICONS.probe" :hint="probe.configured?.check">
        <div class="space-y-2 text-sm">
          <p v-if="probe.configured">
            {{ probe.configured.check }}
            <span class="block text-xs text-muted-foreground">{{ probe.configured.timing }}</span>
          </p>
          <p v-if="probe.answer" class="select-text rounded-lg border bg-surface-1 px-3 py-2 font-mono text-2xs text-muted-foreground">{{ probe.answer }}</p>
        </div>
      </PanelSection>

      <UsageSection v-if="usageSubject" :resource="usageSubject" />

      <PanelSection value="events" title="Recent warnings" :icon="SECTION_ICONS.events">
        <WarningEvents :problem="problem" :objects="eventObjects" />
      </PanelSection>
    </Accordion>
  </div>
</template>
