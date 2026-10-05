<script setup lang="ts">
import yaml from "js-yaml";
import {
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Undo2,
} from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot, type StatusTone } from "@/components/ui/status";
import KindIcon from "@/components/KindIcon.vue";
import DiffView from "@/components/workloads/DiffView.vue";
import { formatAge } from "@/components/tables/age";
import { runCli, runCliForEach, cliErrorMessage, cliSucceeded } from "@/actions/command";
import { injectStrict, formatDateTime } from "@/lib/utils";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { clusterArgs, labelSelectorToString, type LabelSelector } from "@/lib/workloads";
import { confirmDialog, guard } from "@/lib/guardrails/guard";
import {
  Revision,
  RolloutPhase,
  Workload,
  controllerRevisions,
  deploymentRevisions,
  rolloutArgs,
  rolloutProgress,
} from "@/lib/rollout";

/*
 * Rollout history of a Deployment (ReplicaSets) / StatefulSet / DaemonSet
 * (ControllerRevisions): revisions with change cause, age and images, a diff
 * of the pod template between revisions, roll back to a revision, restart,
 * pause / resume, and live rollout progress.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  tabId?: string;
}>();

const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const workload = shallowRef<Workload | null>(null);
const revisions = shallowRef<Revision[]>([]);
const loading = ref(true);
const loadError = ref("");
const busy = ref<"" | "undo" | "restart" | "pause">("");

const selected = ref<number | null>(null);
/* Diff the selected revision against the current one or its predecessor. */
const compareWith = ref<"current" | "previous">("current");

const ref_ = computed(() => `${props.kind.toLowerCase()}/${props.name}`);
const args = computed(() => clusterArgs(props));

const getJson = async (cliArgs: string[]) => {
  const result = await runCli("kubectl", [...cliArgs, "--output=json", ...args.value]);
  if (!cliSucceeded(result)) throw new Error(cliErrorMessage(result));
  return JSON.parse(result.stdout);
};

const load = async (withRevisions = true) => {
  try {
    const object: Workload & { spec?: { selector?: LabelSelector } } =
      await getJson(["get", ref_.value]);
    workload.value = object;
    loadError.value = "";

    if (withRevisions) {
      const selector = labelSelectorToString(object.spec?.selector);
      const resource =
        props.kind === "Deployment" ? "replicasets" : "controllerrevisions";
      const list = await getJson([
        "get",
        resource,
        ...(selector ? [`--selector=${selector}`] : []),
      ]);
      revisions.value =
        props.kind === "Deployment"
          ? deploymentRevisions(object, list.items ?? [])
          : controllerRevisions(object, list.items ?? []);

      if (
        selected.value === null ||
        !revisions.value.some((r) => r.revision === selected.value)
      ) {
        // Default: the newest non-current revision (what "undo" would do).
        selected.value =
          revisions.value.find((r) => !r.current)?.revision ??
          revisions.value[0]?.revision ??
          null;
      }
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
};

/* --------------------------------------------------------- progress -- */

const progress = computed(() =>
  workload.value ? rolloutProgress({ ...workload.value, kind: props.kind }) : null
);

const phaseTone: Record<RolloutPhase, StatusTone> = {
  complete: "success",
  progressing: "info",
  paused: "warning",
  failed: "destructive",
};
const phaseLabel: Record<RolloutPhase, string> = {
  complete: "Rolled out",
  progressing: "Rolling out",
  paused: "Paused",
  failed: "Failed",
};

/* Poll quickly while a rollout is running, slowly otherwise. */
let timer: number | undefined;
let polls = 0;
const schedulePoll = () => {
  window.clearTimeout(timer);
  const fast = progress.value?.phase === "progressing";
  timer = window.setTimeout(async () => {
    polls++;
    // Revisions only change when a rollout starts: refresh them less often.
    await load(fast || polls % 4 === 0);
    schedulePoll();
  }, fast ? 2000 : 10000);
};

/* ------------------------------------------------------------ diff -- */

const byRevision = computed(
  () => new Map(revisions.value.map((r) => [r.revision, r]))
);
const current = computed(() => revisions.value.find((r) => r.current) ?? null);
const selectedRevision = computed(() =>
  selected.value === null ? null : byRevision.value.get(selected.value) ?? null
);

const baseRevision = computed(() => {
  const sel = selectedRevision.value;
  if (!sel) return null;
  if (compareWith.value === "current" && !sel.current) return current.value;
  // Predecessor: the next older revision.
  return revisions.value.find((r) => r.revision < sel.revision) ?? null;
});

const toYaml = (revision: Revision | null) =>
  revision
    ? yaml.dump(revision.template, { sortKeys: true, lineWidth: 120, noRefs: true })
    : "";

/* Rolling back to `selected` turns current -> selected; show it that way. */
const diffOld = computed(() => toYaml(baseRevision.value));
const diffNew = computed(() => toYaml(selectedRevision.value));

const diffLabels = computed(() => ({
  old: baseRevision.value
    ? `r${baseRevision.value.revision}${baseRevision.value.current ? " (current)" : ""}`
    : "(nothing)",
  new: selectedRevision.value
    ? `r${selectedRevision.value.revision}${selectedRevision.value.current ? " (current)" : ""}`
    : "",
}));

/* --------------------------------------------------------- actions -- */

const guardTarget = () => [
  {
    context: props.context,
    kubeConfig: props.kubeConfig,
    name: props.name,
    kind: props.kind,
    namespace: props.namespace,
  },
];

const confirmRollback = async () => {
  const revision = selectedRevision.value;
  if (!revision || revision.current) return;
  const confirmed = await guard("rollback", guardTarget(), {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: `Roll back ${ref_.value} to revision ${revision.revision}?`,
        message:
          `Starts a rolling update to the pod template of revision ${revision.revision}` +
          (revision.images.length ? ` (${revision.images.join(", ")})` : "") +
          ". It becomes the newest revision; replicas and other spec fields are unchanged.",
        confirmLabel: `Roll back to r${revision.revision}`,
      }),
  });
  if (!confirmed) return;
  busy.value = "undo";
  await runCliForEach("kubectl", [revision], {
    args: (r) => [
      ...rolloutArgs("undo", props.kind, props.name, [`--to-revision=${r.revision}`]),
      ...args.value,
    ],
    label: (r) => `${ref_.value} to revision ${r.revision}`,
    successVerb: "Rolled back",
    failureVerb: "roll back",
    guarded: true,
  });
  busy.value = "";
  selected.value = null;
  await load();
  schedulePoll();
};

const confirmRestart = async () => {
  const confirmed = await guard("restart", guardTarget(), {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: `Restart ${ref_.value}?`,
        message: "All pods are replaced through a rolling update, following the update strategy.",
        confirmLabel: "Restart",
      }),
  });
  if (!confirmed) return;
  busy.value = "restart";
  await runCliForEach("kubectl", [props.name], {
    args: () => [...rolloutArgs("restart", props.kind, props.name), ...args.value],
    label: () => ref_.value,
    successVerb: "Restarted",
    failureVerb: "restart",
    guarded: true,
  });
  busy.value = "";
  await load();
  schedulePoll();
};

const paused = computed(() => workload.value?.spec?.paused === true);

const togglePause = async () => {
  const verb = paused.value ? "resume" : "pause";
  if (!(await guard(verb, guardTarget()))) return;
  busy.value = "pause";
  await runCliForEach("kubectl", [props.name], {
    args: () => [...rolloutArgs(verb, props.kind, props.name), ...args.value],
    label: () => ref_.value,
    successVerb: paused.value ? "Resumed rollout of" : "Paused rollout of",
    failureVerb: `${verb} the rollout of`,
    guarded: true,
  });
  busy.value = "";
  await load(false);
  schedulePoll();
};

/* ↑ / ↓ move through the revisions. */
const onListKeydown = (event: KeyboardEvent) => {
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const index = revisions.value.findIndex((r) => r.revision === selected.value);
  const next =
    event.key === "ArrowDown"
      ? Math.min(revisions.value.length - 1, index + 1)
      : Math.max(0, index - 1);
  selected.value = revisions.value[next]?.revision ?? selected.value;
  nextTick(() =>
    document
      .getElementById(`revision-${props.tabId ?? ""}-${selected.value}`)
      ?.scrollIntoView({ block: "nearest" })
  );
};

onMounted(async () => {
  await load();
  schedulePoll();
});
onUnmounted(() => window.clearTimeout(timer));
</script>

<template>
  <div class="flex h-full flex-col bg-background">
    <!-- Header: object, rollout status, actions -->
    <div class="flex h-11 shrink-0 items-center gap-3 border-b bg-surface-1 px-3">
      <KindIcon :name="kind" class="text-muted-foreground" />
      <span class="truncate font-mono text-sm font-medium">{{ ref_ }}</span>
      <span class="hidden truncate text-xs text-muted-foreground md:inline"
        >{{ context }} › {{ namespace }}</span
      >
      <template v-if="progress">
        <span
          class="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium"
          :title="progress.message"
        >
          <StatusDot
            :tone="phaseTone[progress.phase]"
            :pulse="progress.phase === 'progressing'"
          />
          {{ phaseLabel[progress.phase] }}
        </span>
        <div class="hidden w-40 shrink-0 items-center gap-2 lg:flex" aria-hidden="true">
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full transition-[width] duration-slow ease-out"
              :class="progress.phase === 'failed' ? 'bg-destructive' : progress.phase === 'complete' ? 'bg-success' : 'bg-primary'"
              :style="{ width: `${Math.round(progress.ratio * 100)}%` }"
            />
          </div>
        </div>
        <span class="hidden truncate text-xs tabular-nums text-muted-foreground xl:inline">
          {{ progress.updated }} updated · {{ progress.ready }} ready ·
          {{ progress.available }} available of {{ progress.desired }}
        </span>
      </template>

      <div class="ml-auto flex shrink-0 items-center gap-1.5">
        <Button
          v-if="kind === 'Deployment'"
          variant="outline"
          size="sm"
          :disabled="busy !== '' || !workload"
          @click="togglePause"
        >
          <Loader2 v-if="busy === 'pause'" class="h-3.5 w-3.5 animate-spin" />
          <Play v-else-if="paused" class="h-3.5 w-3.5" />
          <Pause v-else class="h-3.5 w-3.5" />
          {{ paused ? "Resume rollout" : "Pause rollout" }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy !== '' || !workload"
          @click="confirmRestart"
        >
          <Loader2 v-if="busy === 'restart'" class="h-3.5 w-3.5 animate-spin" />
          <RotateCcw v-else class="h-3.5 w-3.5" />
          Restart
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          aria-label="Refresh"
          title="Refresh"
          @click="load()"
        >
          <RefreshCw class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="loadError && !workload" class="flex flex-1 items-center justify-center p-4">
      <EmptyState :icon="TriangleAlert" :title="`Unable to load ${ref_}`" class="max-w-xl">
        <pre class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{ loadError }}</pre>
        <template #action>
          <Button variant="outline" size="sm" @click="load()">Retry</Button>
        </template>
      </EmptyState>
    </div>
    <div v-else class="flex min-h-0 flex-1">
      <!-- Revisions -->
      <div
        class="flex w-80 min-w-[18rem] flex-col border-r bg-surface-1"
        role="listbox"
        aria-label="Revisions"
        tabindex="0"
        @keydown="onListKeydown"
      >
        <div
          class="flex h-9 shrink-0 items-center px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground"
        >
          Revisions
          <span class="ml-auto font-normal normal-case tracking-normal tabular-nums">{{
            revisions.length
          }}</span>
        </div>
        <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-2">
          <EmptyState
            v-if="revisions.length === 0"
            title="No revisions found"
            description="The controller keeps old revisions up to revisionHistoryLimit."
            size="sm"
          />
          <button
            v-for="revision in revisions"
            :id="`revision-${tabId ?? ''}-${revision.revision}`"
            :key="revision.revision"
            type="button"
            role="option"
            :aria-selected="revision.revision === selected"
            class="block w-full rounded-md border px-2.5 py-2 text-left transition-colors duration-fast focus-ring"
            :class="
              revision.revision === selected
                ? 'border-primary/40 bg-primary/10'
                : 'border-transparent hover:bg-accent'
            "
            @click="selected = revision.revision"
          >
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-semibold tabular-nums">r{{ revision.revision }}</span>
              <Badge v-if="revision.current" variant="success" size="sm">Current</Badge>
              <span
                class="ml-auto text-xs tabular-nums text-muted-foreground"
                :title="revision.created ? formatDateTime(revision.created) : ''"
                >{{ formatAge(revision.created) }}</span
              >
            </div>
            <p
              class="mt-1 line-clamp-2 text-xs"
              :class="revision.changeCause ? 'text-foreground' : 'italic text-muted-foreground'"
            >
              {{ revision.changeCause || "No change cause recorded" }}
            </p>
            <p
              v-for="image in revision.images"
              :key="image"
              class="mt-0.5 truncate font-mono text-2xs text-muted-foreground"
              :title="image"
            >
              {{ image }}
            </p>
            <p
              v-if="revision.replicas !== undefined && revision.replicas > 0"
              class="mt-1 text-2xs tabular-nums text-muted-foreground"
            >
              {{ revision.readyReplicas }}/{{ revision.replicas }} pods ready
            </p>
          </button>
        </div>
      </div>

      <!-- Diff + rollback -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div
          class="flex h-11 shrink-0 items-center gap-2 border-b px-3"
          role="toolbar"
          aria-label="Compare revisions"
        >
          <span class="text-xs text-muted-foreground">Compare with</span>
          <div class="inline-flex h-7 items-center rounded-md bg-muted p-0.5" role="group">
            <button
              v-for="option in (['current', 'previous'] as const)"
              :key="option"
              type="button"
              class="h-6 rounded-[5px] px-2 text-xs font-medium transition-colors duration-fast focus-ring"
              :class="
                compareWith === option
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              "
              :aria-pressed="compareWith === option"
              @click="compareWith = option"
            >
              {{ option === "current" ? "Current revision" : "Previous revision" }}
            </button>
          </div>
          <Button
            class="ml-auto"
            size="sm"
            :disabled="!selectedRevision || selectedRevision.current || busy !== ''"
            @click="confirmRollback"
          >
            <Loader2 v-if="busy === 'undo'" class="h-3.5 w-3.5 animate-spin" />
            <Undo2 v-else class="h-3.5 w-3.5" />
            {{
              selectedRevision && !selectedRevision.current
                ? `Roll back to r${selectedRevision.revision}`
                : "Roll back"
            }}
          </Button>
        </div>
        <div class="min-h-0 flex-1">
          <DiffView
            v-if="selectedRevision"
            :old-text="diffOld"
            :new-text="diffNew"
            :old-label="diffLabels.old"
            :new-label="diffLabels.new"
            :empty-text="
              baseRevision
                ? 'The pod templates are identical'
                : 'This is the oldest retained revision'
            "
          />
          <div v-else class="flex h-full items-center justify-center">
            <EmptyState title="Select a revision" size="sm" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
