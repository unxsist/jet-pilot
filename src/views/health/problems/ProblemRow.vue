<script setup lang="ts">
/**
 * One problem on the Problems tab, kept calm: what it is about, one quiet
 * line saying what's wrong, and its state in words with how many pods.
 * Fixes and shortcuts show on hover; the evidence lives in the side panel.
 */
import { MoreHorizontal, ScrollText } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import KindIcon from "@/components/KindIcon.vue";
import { cn, formatDateTime } from "@/lib/utils";
import { relativeTime } from "@/lib/clusters/status";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { ago } from "@/lib/resources/format";
import { podsWords } from "@/lib/health/problems/group";
import { subjectIcon } from "@/lib/health/problems/actions";
import { SNOOZES, type Snooze } from "@/lib/health/problems/snooze";
import { fixLabel, fixesFor, hasLogs, type FixId } from "@/lib/health/problems/fixes";
import type { Problem } from "@/lib/health/problems/model";

const props = defineProps<{
  problem: Problem;
  focused: boolean;
  /** Its details are open. */
  open: boolean;
  /** Several clusters are active: say which one it is in. */
  cluster?: string;
  now: number;
  /** Snoozed (or acknowledged): shown dimmed, with when it comes back. */
  snooze?: Snooze;
  canAsk: boolean;
}>();

const emit = defineEmits<{
  open: [];
  focus: [];
  fix: [fix: FixId];
  logs: [];
  openSubject: [];
  ask: [];
  snooze: [ms?: number];
  unsnooze: [];
}>();

const fixes = computed(() => fixesFor(props.problem));
const pods = computed(() => podsWords(props.problem));
const logs = computed(() => hasLogs(props.problem));

const detail = computed(() =>
  [props.cluster, props.problem.namespace, props.problem.short].filter(Boolean).join(" · ")
);

const when = computed(() => {
  const at = props.problem.firstSeen;
  if (at === undefined) return null;
  const last = props.problem.lastSeen;
  return {
    text: relativeTime(at, props.now),
    title: `Started ${formatDateTime(new Date(at))}${last !== undefined && props.now - last > 60_000 ? ` · last seen ${ago(last, props.now)}` : ""}`,
  };
});

const snoozedUntil = computed(() => {
  const until = props.snooze?.until;
  if (!props.snooze) return "";
  if (until === undefined) return "Until it's resolved";
  const date = new Date(until);
  const today = new Date(props.now).toDateString() === date.toDateString();
  return `Until ${today ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
});

const readOnly = computed(() => {
  const cluster = guardedCluster(props.problem.context, props.problem.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});
</script>

<template>
  <div
    role="row"
    :aria-selected="open"
    :data-problem-key="problem.fingerprint"
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
    <span class="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground/80" :title="problem.subject.kind">
      <KindIcon :name="subjectIcon(problem)" class="h-[18px] w-[18px]" />
    </span>

    <div class="min-w-0 flex-1" :class="snooze && 'opacity-70'">
      <span class="block truncate text-sm font-medium text-foreground">{{ problem.subject.name }}</span>
      <p class="truncate text-xs text-muted-foreground" :title="detail">{{ detail }}</p>
    </div>

    <div class="w-44 shrink-0 text-xs" :title="problem.findings[0]?.message">
      <div class="flex min-w-0 items-center gap-2">
        <StatusDot :tone="snooze ? 'muted' : problem.tone" />
        <span class="truncate font-medium" :class="snooze ? 'text-muted-foreground' : statusTextClass[problem.tone]">
          {{ problem.label }}
        </span>
      </div>
      <p v-if="snooze || pods" class="mt-0.5 truncate pl-4 text-muted-foreground">{{ snooze ? snoozedUntil : pods }}</p>
    </div>

    <span class="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground" :title="when?.title">
      {{ when?.text ?? "" }}
    </span>

    <!-- Actions show on hover / focus (the wrapper fades: disabled buttons set their own opacity). -->
    <div
      class="flex w-[4.25rem] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100"
    >
      <Button
        v-if="logs"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        title="Logs"
        :aria-label="`Logs of ${problem.subject.name}`"
        @click.stop="emit('logs')"
      >
        <ScrollText class="h-3.5 w-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground" :aria-label="`Actions for ${problem.subject.name}`" @click.stop>
            <MoreHorizontal class="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56" @click.stop>
          <DropdownMenuItem @select="emit('open')">
            Details
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
          <template v-if="fixes.length">
            <DropdownMenuSeparator />
            <DropdownMenuItem
              v-for="fix in fixes"
              :key="fix"
              :disabled="!!readOnly"
              :title="readOnly || undefined"
              @select="emit('fix', fix)"
            >
              {{ fixLabel(fix, problem) }}
            </DropdownMenuItem>
          </template>
          <DropdownMenuSeparator />
          <DropdownMenuItem v-if="logs" @select="emit('logs')">
            Logs
            <DropdownMenuShortcut>L</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('openSubject')">Open {{ problem.subject.kind }}</DropdownMenuItem>
          <DropdownMenuItem v-if="canAsk" @select="emit('ask')">Ask AI</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem v-if="snooze" @select="emit('unsnooze')">Show again</DropdownMenuItem>
          <template v-else>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Snooze</DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-40">
                <DropdownMenuItem v-for="option in SNOOZES" :key="option.id" @select="emit('snooze', option.ms)">
                  {{ option.label }}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem title="Hidden until it's resolved; it shows again if it comes back" @select="emit('snooze')">
              Acknowledge
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
