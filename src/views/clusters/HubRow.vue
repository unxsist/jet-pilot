<script setup lang="ts">
/**
 * One cluster in the Clusters hub: status + avatar, alias and environment,
 * where it runs, its version and nodes, how it signs in, and actions.
 */
import {
  Check,
  Lock,
  MoreHorizontal,
  ShieldAlert,
  Star,
  TriangleAlert,
} from "lucide-vue-next";
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
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { cn } from "@/lib/utils";
import type { HubCluster } from "@/lib/clusters/hubModel";
import { STATUS_LABELS, STATUS_TONES, relativeTime } from "@/lib/clusters/status";
import { PROVIDER_LABELS } from "@/lib/clusters/provider";

const props = defineProps<{
  cluster: HubCluster;
  selected: boolean;
  /** Show the selection checkbox even without hover (a selection exists). */
  selecting: boolean;
  focused: boolean;
  modKey: string;
}>();

const emit = defineEmits<{
  connect: [];
  addToActive: [];
  disconnect: [];
  edit: [];
  favorite: [];
  hide: [];
  check: [];
  copy: [];
  select: [on: boolean];
  focus: [];
}>();

const meta = computed(() => props.cluster.meta);
const entry = computed(() => props.cluster.entry);
const status = computed(() => props.cluster.status);

const tone = computed(() => (status.value ? STATUS_TONES[status.value.reachability] : null));
const statusTitle = computed(() => {
  const s = status.value;
  if (!s) return "Not checked yet";
  const when = relativeTime(s.checkedAt);
  const lines = [`${STATUS_LABELS[s.reachability]} · checked ${when}`];
  if (s.message) lines.push(s.message);
  if (s.reachability !== "reachable" && s.lastOkAt) lines.push(`Last reachable ${relativeTime(s.lastOkAt)}`);
  if (s.latencyMs != null && s.reachability === "reachable") lines.push(`${s.latencyMs} ms`);
  return lines.join("\n");
});

const providerDetail = computed(() =>
  [entry.value.provider.region, entry.value.provider.account].filter(Boolean).join(" · ")
);

const AUTH_TEXT: Record<string, string> = {
  token: "Token",
  clientCert: "Certificate",
  authProvider: "Auth provider",
  basic: "Password",
  none: "No credentials",
};
const authText = computed(() => {
  const auth = entry.value.auth;
  if (auth.kind === "exec") {
    const command = auth.command ?? "Exec plugin";
    return auth.awsProfile ? `${command} · ${auth.awsProfile}` : command;
  }
  return AUTH_TEXT[auth.kind] ?? auth.kind;
});
const interactive = computed(() => entry.value.auth.interactive === "interactive");
/* "v1.31.4-eks-2d5f260" → "v1.31.4" (full version in the tooltip). */
const shortVersion = computed(() => /^v?\d+\.\d+\.\d+/.exec(status.value?.serverVersion ?? "")?.[0] ?? status.value?.serverVersion);
const problems = computed(() => entry.value.problems.map((p) => p.message).join("\n"));
</script>

<template>
  <div
    role="row"
    :aria-selected="selected"
    :data-cluster-key="encodeURIComponent(cluster.entry.key)"
    :tabindex="focused ? 0 : -1"
    :class="
      cn(
        'group/row grid h-12 cursor-default grid-cols-[1.25rem_2rem_minmax(0,1fr)_minmax(0,11rem)_4.5rem_4rem_minmax(0,10rem)_auto] items-center gap-x-3 px-3 outline-none transition-colors duration-fast',
        'hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        selected && 'bg-primary/[0.06] hover:bg-primary/10',
        meta.hidden && 'opacity-60'
      )
    "
    @focus="emit('focus')"
    @dblclick="emit('connect')"
  >
    <Checkbox
      :checked="selected"
      :class="selecting || selected ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'"
      :aria-label="`Select ${meta.displayName}`"
      @update:checked="(on: boolean) => emit('select', on)"
      @click.stop
    />

    <span :title="statusTitle">
      <ContextAvatar :name="entry.context" :kube-config="entry.kubeConfig" :status="tone === 'muted' ? null : tone" />
    </span>

    <div class="min-w-0">
      <div class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-medium" :title="entry.context">{{ meta.displayName }}</span>
        <EnvBadge v-if="meta.env" :env="meta.env" :inferred="meta.envInferred" />
        <ShieldAlert
          v-if="meta.protected"
          class="h-3.5 w-3.5 shrink-0 text-destructive"
          aria-label="Protected"
          title="Protected: destructive actions need a typed confirmation"
        />
        <Lock v-if="meta.readOnly" class="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Read-only" title="Read-only in JET Pilot" />
        <Star v-if="meta.favorite" class="h-3 w-3 shrink-0 fill-current text-warning" aria-label="Favourite" />
      </div>
      <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span v-if="meta.displayName !== entry.context" class="truncate font-mono text-2xs">{{ entry.context }}</span>
        <span v-else-if="meta.tags.length" class="truncate">{{ meta.tags.join(" · ") }}</span>
        <span v-else-if="entry.namespace" class="truncate">{{ entry.namespace }}</span>
        <span
          v-if="status && status.reachability !== 'reachable' && status.reachability !== 'skipped'"
          class="truncate"
          :class="tone === 'destructive' ? 'text-destructive' : 'text-warning'"
        >
          {{ STATUS_LABELS[status.reachability] }}
        </span>
      </div>
    </div>

    <div class="flex min-w-0 items-center gap-2" :title="PROVIDER_LABELS[entry.provider.id]">
      <ProviderMark :provider="entry.provider.id" :context="entry.context" />
      <span class="truncate text-xs text-muted-foreground">
        {{ providerDetail || PROVIDER_LABELS[entry.provider.id] }}
      </span>
    </div>

    <span class="truncate font-mono text-xs tabular-nums text-muted-foreground" :title="status?.serverVersion ?? undefined">
      {{ shortVersion ?? "—" }}
    </span>
    <span class="text-xs tabular-nums text-muted-foreground">
      <template v-if="status?.nodeCount != null">{{ status.nodeCount }} {{ status.nodeCount === 1 ? "node" : "nodes" }}</template>
      <template v-else>—</template>
    </span>

    <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" :title="problems || authText">
      <TriangleAlert v-if="problems" class="h-3.5 w-3.5 shrink-0 text-warning" />
      <span class="truncate font-mono text-2xs">{{ authText }}</span>
      <span v-if="interactive" class="shrink-0 rounded border px-1 text-2xs">sign-in</span>
    </div>

    <div class="flex items-center justify-end gap-1">
      <span
        v-if="cluster.active"
        class="mr-1 inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-2xs font-medium text-success"
      >
        <Check class="h-3 w-3" /> Connected
      </span>
      <Button
        v-else
        size="sm"
        variant="outline"
        class="h-7 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        @click.stop="emit('connect')"
      >
        Connect
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            :aria-label="`Actions for ${meta.displayName}`"
            @click.stop
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
          <DropdownMenuItem :disabled="interactive" @select="emit('check')">
            Check status
            <span v-if="interactive" class="ml-auto pl-3 text-2xs text-muted-foreground">needs sign-in</span>
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('copy')">Copy context name</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
