<script setup lang="ts">
/**
 * The top of the delivery panel: its state in words, what the controller
 * said last (readable, long messages folded) and when, and the actions:
 * Reconcile / Suspend for Flux, Sync / Refresh for Argo CD.
 */
import { ChevronDown, Loader2, Pause, Play, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { formatDateTime, injectStrict } from "@/lib/utils";
import { relativeTime } from "@/lib/clusters/status";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { reconcile, refresh, setSuspended } from "@/lib/gitops/actions";
import { openSyncDialog } from "@/lib/gitops/ui";
import type { Delivery } from "@/lib/gitops/model";

const props = defineProps<{ delivery: Delivery; now: number }>();
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const state = computed(() => props.delivery.state);
const problem = computed(() => state.value.category === "failing" || state.value.category === "attention");
const busy = computed(() => state.value.category === "progressing");
const flux = computed(() => props.delivery.tool === "flux");

const when = computed(() => {
  // Argo CD's last sync is in its own line.
  if (!flux.value && state.value.since === props.delivery.lastApplied) return null;
  const at = state.value.since ? new Date(state.value.since).getTime() : NaN;
  if (Number.isNaN(at)) return null;
  const relative = relativeTime(at, props.now);
  return {
    text: problem.value && relative !== "just now" ? `for ${relative.replace(/ ago$/, "")}` : relative,
    title: formatDateTime(new Date(at)),
  };
});

/*
 * Argo CD: one quiet line in words, e.g. "Healthy · manual sync · last
 * synced 3d ago": the health (or the sync status, when the state is about
 * health), the sync policy and the last sync.
 */
const HEALTH_STATES = ["Degraded", "Missing", "Progressing", "Suspended"];
const argoLine = computed(() => {
  if (flux.value) return "";
  const object = props.delivery.object;
  const sync = object.status?.sync?.status ?? "Unknown";
  const health = object.status?.health?.status ?? "Unknown";
  const parts = [
    HEALTH_STATES.includes(state.value.label)
      ? sync === "OutOfSync"
        ? "Out of sync"
        : sync === "Synced"
          ? "Synced"
          : "Sync status unknown"
      : health === "Unknown"
        ? "Health unknown"
        : health,
    object.spec?.syncPolicy?.automated ? "auto-sync" : "manual sync",
  ];
  const at = props.delivery.lastApplied ? new Date(props.delivery.lastApplied).getTime() : NaN;
  if (!Number.isNaN(at)) parts.push(`last synced ${relativeTime(at, props.now)}`);
  return parts.join(" · ");
});

const LONG = 220;
const expanded = ref(false);
const message = computed(() => state.value.message ?? "");
const long = computed(() => message.value.length > LONG || message.value.split("\n").length > 4);
watch(message, () => (expanded.value = false));

const boxClass = computed(() =>
  state.value.category === "failing"
    ? "rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-foreground"
    : state.value.category === "attention"
      ? "rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-foreground"
      : "text-muted-foreground"
);

const readOnly = computed(() => {
  const cluster = guardedCluster(props.delivery.context, props.delivery.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});
const object = computed(() => props.delivery.object);
</script>

<template>
  <div class="space-y-3 border-b px-4 pb-4 pt-3.5">
    <div class="flex items-center gap-2.5">
      <StatusDot :tone="state.tone" :pulse="busy" />
      <span
        class="text-base font-semibold"
        :class="problem ? statusTextClass[state.tone] : 'text-foreground'"
        :title="state.reason"
        >{{ state.label }}</span
      >
      <span v-if="when" class="text-xs tabular-nums text-muted-foreground" :title="when.title">{{ when.text }}</span>
    </div>

    <p v-if="argoLine" class="-mt-1.5 text-xs text-muted-foreground">{{ argoLine }}</p>

    <div v-if="message" :class="boxClass" class="text-xs leading-relaxed">
      <p class="select-text whitespace-pre-wrap break-words" :class="!expanded && long ? 'line-clamp-4' : ''">{{ message }}</p>
      <button v-if="long" type="button" class="mt-1 font-medium text-link hover:underline" @click="expanded = !expanded">
        {{ expanded ? "Show less" : "Show all" }}
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-1.5" :title="readOnly || undefined">
      <template v-if="flux">
        <div class="inline-flex">
          <Button
            size="sm"
            class="rounded-r-none"
            :disabled="!!readOnly || delivery.suspended || busy"
            :title="delivery.suspended ? 'Resume it first' : 'Apply what is in the source now'"
            @click="reconcile(object)"
          >
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            {{ busy ? `${state.label}…` : "Reconcile" }}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                size="sm"
                class="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                :disabled="!!readOnly || delivery.suspended || busy"
                aria-label="More ways to reconcile"
              >
                <ChevronDown class="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-64">
              <DropdownMenuItem @select="reconcile(object, { withSource: true })">
                <span class="grid gap-0.5">
                  <span>Reconcile with source</span>
                  <span class="text-xs text-muted-foreground">Fetch the source first, then apply</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          size="sm"
          variant="outline"
          :disabled="!!readOnly"
          @click="setSuspended(object, !delivery.suspended)"
        >
          <Play v-if="delivery.suspended" class="h-3.5 w-3.5" />
          <Pause v-else class="h-3.5 w-3.5" />
          {{ delivery.suspended ? "Resume" : "Suspend" }}
        </Button>
      </template>
      <template v-else>
        <Button size="sm" :disabled="!!readOnly || busy" @click="openSyncDialog(spawnDialog, object)">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
          {{ busy ? `${state.label}…` : "Sync…" }}
        </Button>
        <div class="inline-flex">
          <Button size="sm" variant="outline" class="rounded-r-none" :disabled="!!readOnly" @click="refresh(object)">
            Refresh
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                size="sm"
                variant="outline"
                class="-ml-px rounded-l-none px-1.5"
                :disabled="!!readOnly"
                aria-label="More ways to refresh"
              >
                <ChevronDown class="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-64">
              <DropdownMenuItem @select="refresh(object, true)">
                <span class="grid gap-0.5">
                  <span>Hard refresh</span>
                  <span class="text-xs text-muted-foreground">Render the manifests again, skipping the cache</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </template>
    </div>
  </div>
</template>
