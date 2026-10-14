<script setup lang="ts">
/**
 * One delivery on the GitOps page, kept calm: the tool's mark, its name,
 * one quiet line (where it comes from, or what's wrong) and its state in
 * words. Actions show on hover; the details live in the side panel.
 */
import { Loader2, MoreHorizontal, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import ToolMark from "@/components/gitops/ToolMark.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/clusters/status";
import { formatDateTime } from "@/lib/utils";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { TOOL_LABELS, type Delivery } from "@/lib/gitops/model";

const props = defineProps<{
  delivery: Delivery;
  focused: boolean;
  /** Its details are open. */
  open: boolean;
  /** Several contexts are active: say which one. */
  showContext: boolean;
  now: number;
}>();

const emit = defineEmits<{
  open: [];
  focus: [];
  reconcile: [withSource: boolean];
  suspend: [suspend: boolean];
  sync: [];
  refresh: [hard: boolean];
  editYaml: [];
}>();

const state = computed(() => props.delivery.state);
const problem = computed(() => state.value.category === "failing" || state.value.category === "attention");
const busy = computed(() => state.value.category === "progressing");
const flux = computed(() => props.delivery.tool === "flux");

/* Problems say what's wrong; everything else where it comes from. */
const detail = computed(() =>
  problem.value && state.value.message ? state.value.message : props.delivery.source.short
);

const when = computed(() => {
  const at = props.delivery.lastApplied ? new Date(props.delivery.lastApplied).getTime() : NaN;
  return Number.isNaN(at) ? null : { text: relativeTime(at, props.now), title: formatDateTime(new Date(at)) };
});

const readOnly = computed(() => {
  const cluster = guardedCluster(props.delivery.context, props.delivery.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const primaryLabel = computed(() => (flux.value ? "Reconcile" : "Sync"));
const primaryDisabled = computed(
  () => !!readOnly.value || props.delivery.suspended || (busy.value && !flux.value)
);
const primary = () => (flux.value ? emit("reconcile", false) : emit("sync"));
</script>

<template>
  <div
    role="row"
    :aria-selected="open"
    :data-delivery-key="delivery.key"
    :tabindex="focused ? 0 : -1"
    :class="
      cn(
        'group/row relative flex h-14 cursor-default items-center gap-3 rounded-lg px-3 outline-none transition-colors duration-fast ease-out',
        'hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        open && 'bg-accent/70 hover:bg-accent/70'
      )
    "
    @focusin="emit('focus')"
    @click="emit('open')"
  >
    <span
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-surface-1 text-muted-foreground"
      :title="TOOL_LABELS[delivery.tool]"
    >
      <ToolMark :tool="delivery.tool" :size="16" />
    </span>

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="truncate text-sm font-medium text-foreground">{{ delivery.name }}</span>
      </div>
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span v-if="showContext" class="inline-flex shrink-0" :title="delivery.context">
          <ContextAvatar :name="delivery.context" :kube-config="delivery.kubeConfig" size="sm" class="h-3.5 w-3.5 rounded text-[7px]" />
          <span class="sr-only">{{ delivery.context }}</span>
        </span>
        <span class="truncate" :title="detail">{{ detail }}</span>
      </p>
    </div>

    <div class="flex w-48 shrink-0 items-center gap-2 text-xs" :title="state.reason">
      <StatusDot :tone="state.tone" :pulse="busy" />
      <span :class="problem ? cn('font-medium', statusTextClass[state.tone]) : 'text-muted-foreground'" class="truncate">
        {{ state.label }}
      </span>
    </div>

    <span class="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground" :title="when?.title">
      {{ when?.text ?? "" }}
    </span>

    <!-- Actions show on hover / focus (the wrapper fades: disabled buttons set their own opacity). -->
    <div
      class="flex w-[4.25rem] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        :disabled="primaryDisabled"
        :title="readOnly || (delivery.suspended ? 'Resume it first' : primaryLabel)"
        :aria-label="`${primaryLabel} ${delivery.name}`"
        @click.stop="primary"
      >
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            :aria-label="`Actions for ${delivery.name}`"
            @click.stop
          >
            <MoreHorizontal class="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56">
          <DropdownMenuItem @select="emit('open')">
            Details
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <template v-if="flux">
            <DropdownMenuItem :disabled="!!readOnly || delivery.suspended" @select="emit('reconcile', false)">
              Reconcile
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!!readOnly || delivery.suspended" @select="emit('reconcile', true)">
              Reconcile with source
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!!readOnly" @select="emit('suspend', !delivery.suspended)">
              {{ delivery.suspended ? "Resume" : "Suspend" }}
            </DropdownMenuItem>
          </template>
          <template v-else>
            <DropdownMenuItem :disabled="!!readOnly || busy" @select="emit('sync')">
              Sync…
              <DropdownMenuShortcut>S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!!readOnly" @select="emit('refresh', false)">
              Refresh
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!!readOnly" @select="emit('refresh', true)">Hard refresh</DropdownMenuItem>
          </template>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('editYaml')">Edit YAML</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
