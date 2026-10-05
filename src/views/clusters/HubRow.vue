<script setup lang="ts">
/**
 * One cluster in the Clusters hub, kept calm: its avatar (with a status
 * dot), name and where it runs, and on the right only what needs you (a
 * problem, a sign-in), else whether it's connected or its version. The
 * rest lives in the details panel (click) and the menu.
 */
import { Check, KeyRound, Lock, MoreHorizontal, ShieldAlert } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ContextAvatar from "@/components/ContextAvatar.vue";
import EnvBadge from "@/components/clusters/EnvBadge.vue";
import { cn } from "@/lib/utils";
import { clusterSubtitle, minorVersion, rowAttention, type HubCluster } from "@/lib/clusters/hubModel";
import { STATUS_TONES } from "@/lib/clusters/status";
import { requestSignIn, useCredential } from "@/lib/auth/center";
import { credentialBadge } from "@/lib/auth/badge";
import type { CatalogCluster } from "@/lib/clusters/cloud";

const props = defineProps<{
  cluster: HubCluster;
  selected: boolean;
  /** Selection mode: every row shows its checkbox. */
  selecting: boolean;
  focused: boolean;
  /** Its details are open. */
  open: boolean;
  modKey: string;
  /** Its entry in a cloud account's catalog (added from there). */
  cloud?: CatalogCluster | null;
}>();

const emit = defineEmits<{
  open: [event: MouseEvent];
  connect: [];
  addToActive: [];
  disconnect: [];
  edit: [];
  favorite: [];
  hide: [];
  check: [];
  copy: [];
  remove: [];
  export: [];
  select: [on: boolean];
  focus: [];
}>();

const meta = computed(() => props.cluster.meta);
const entry = computed(() => props.cluster.entry);
const tone = computed(() => {
  const t = props.cluster.status ? STATUS_TONES[props.cluster.status.reachability] : null;
  return t === "muted" ? null : t;
});
const subtitle = computed(() => clusterSubtitle(props.cluster, props.cloud));
const attention = computed(() => rowAttention(props.cluster, props.cloud?.state === "removed"));

/* Credentials only show up here when they need you. */
const credential = useCredential(
  () => entry.value.context,
  () => entry.value.kubeConfig
);
const signIn = computed(() => {
  const badge = credentialBadge(credential.value, Date.now());
  return badge && (badge.tone === "warning" || badge.tone === "destructive") ? badge : null;
});
const version = computed(() => minorVersion(props.cluster.status?.serverVersion));
</script>

<template>
  <div
    role="row"
    :aria-selected="selected"
    :data-cluster-key="encodeURIComponent(cluster.entry.key)"
    :tabindex="focused ? 0 : -1"
    :class="
      cn(
        'group/row relative flex h-14 cursor-default items-center gap-3 rounded-lg px-3 outline-none transition-colors duration-fast',
        'hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        open && 'bg-accent/70 hover:bg-accent/70',
        selected && 'bg-primary/[0.07] hover:bg-primary/10',
        meta.hidden && 'opacity-60'
      )
    "
    @focus="emit('focus')"
    @click="(event) => emit('open', event)"
    @dblclick="emit('connect')"
  >
    <Checkbox
      v-if="selecting"
      :checked="selected"
      :aria-label="`Select ${meta.displayName}`"
      @update:checked="(on: boolean) => emit('select', on)"
      @click.stop
    />

    <ContextAvatar :name="entry.context" :kube-config="entry.kubeConfig" :status="tone" class="[--avatar-ring:var(--background)]" />

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate text-sm font-medium text-foreground">{{ meta.displayName }}</span>
        <EnvBadge v-if="meta.env && !meta.envInferred" :env="meta.env" />
        <ShieldAlert v-if="meta.protected" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Protected" />
        <Lock v-if="meta.readOnly" class="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Read-only" />
      </div>
      <p class="truncate text-xs text-muted-foreground">{{ subtitle }}</p>
    </div>

    <div class="flex shrink-0 items-center justify-end text-xs">
      <span
        v-if="attention"
        class="flex items-center gap-1.5"
        :class="attention.tone === 'destructive' ? 'text-destructive' : 'text-warning'"
        :title="attention.title"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-current" />
        {{ attention.text }}
      </span>
      <button
        v-else-if="signIn"
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors duration-fast focus-ring"
        :class="signIn.tone === 'destructive' ? 'text-destructive hover:bg-destructive/10' : 'text-warning hover:bg-warning/10'"
        :title="signIn.title"
        :disabled="!signIn.signIn"
        @click.stop="requestSignIn(credential.target)"
        @dblclick.stop
      >
        <KeyRound class="h-3.5 w-3.5" />
        {{ signIn.signIn ? (signIn.tone === "destructive" ? "Sign in again" : "Sign in") : signIn.text }}
      </button>
      <span v-else-if="cluster.active" class="flex items-center gap-1.5 text-success">
        <Check class="h-3.5 w-3.5" /> Connected
      </span>
      <span v-else-if="version" class="font-mono tabular-nums text-muted-foreground" :title="cluster.status?.serverVersion ?? undefined">
        v{{ version }}
      </span>
    </div>

    <div class="flex w-[7.25rem] shrink-0 items-center justify-end gap-1">
      <Button
        v-if="!cluster.active"
        size="sm"
        variant="outline"
        class="h-7 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        @click.stop="emit('connect')"
        @dblclick.stop
      >
        Connect
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`Actions for ${meta.displayName}`"
            @click.stop
            @dblclick.stop
          >
            <MoreHorizontal class="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuItem @select="emit('connect')">
            Connect
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="!cluster.active" @select="emit('addToActive')">
            Add to active clusters
            <DropdownMenuShortcut>{{ modKey }}↵</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem v-else @select="emit('disconnect')">Disconnect</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('edit')">
            Edit details…
            <DropdownMenuShortcut>E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('favorite')">
            {{ meta.favorite ? "Remove from favourites" : "Add to favourites" }}
            <DropdownMenuShortcut>F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('hide')">
            {{ meta.hidden ? "Show in lists" : "Hide" }}
            <DropdownMenuShortcut>H</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="entry.auth.interactive === 'interactive'" @select="emit('check')">
            Check status
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('copy')">Copy context name</DropdownMenuItem>
          <template v-if="entry.origin === 'managed'">
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="emit('export')">Export…</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" @select="emit('remove')">Remove from JET Pilot…</DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
