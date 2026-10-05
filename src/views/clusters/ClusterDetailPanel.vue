<script setup lang="ts">
/**
 * Everything about one cluster, next to the hub's list (click a row): its
 * status, version and nodes, how it signs in and until when, where it runs,
 * its server, context and kubeconfig, how it's organised and its
 * guardrails, with the actions.
 */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Lock, MoreHorizontal, ShieldAlert, Sparkles, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/ui/status";
import ContextAvatar from "@/components/ContextAvatar.vue";
import EnvBadge from "@/components/clusters/EnvBadge.vue";
import CredentialBadge from "@/components/auth/CredentialBadge.vue";
import { useToast } from "@/components/ui/toast";
import { clusterSubtitle, type HubCluster } from "@/lib/clusters/hubModel";
import { STATUS_LABELS, STATUS_TONES, relativeTime } from "@/lib/clusters/status";
import { envInfo } from "@/lib/clusters/meta";
import { ORIGIN_LABELS } from "@/lib/kubeconfigSources";
import type { CatalogCluster } from "@/lib/clusters/cloud";

const props = defineProps<{ cluster: HubCluster; cloud?: CatalogCluster | null }>();
const emit = defineEmits<{
  close: [];
  connect: [];
  addToActive: [];
  disconnect: [];
  edit: [];
  favorite: [];
  hide: [];
  check: [];
  export: [];
  remove: [];
}>();

const { toast } = useToast();
const meta = computed(() => props.cluster.meta);
const entry = computed(() => props.cluster.entry);
const status = computed(() => props.cluster.status);
const subtitle = computed(() => clusterSubtitle(props.cluster, props.cloud));

const statusLine = computed(() => {
  const s = status.value;
  if (!s) return entry.value.auth.interactive === "interactive" ? "Not checked: needs a sign-in" : "Not checked yet";
  return STATUS_LABELS[s.reachability];
});
const statusDetail = computed(() => {
  const s = status.value;
  if (!s) return null;
  const parts = [];
  if (s.reachability === "reachable" && s.latencyMs != null) parts.push(`${s.latencyMs} ms`);
  parts.push(`checked ${relativeTime(s.checkedAt)}`);
  if (s.message && s.reachability !== "reachable") parts.unshift(s.message);
  return parts.join(" · ");
});
const tone = computed(() => (status.value ? STATUS_TONES[status.value.reachability] : "muted"));

const AUTH_TEXT: Record<string, string> = {
  token: "A token",
  clientCert: "A client certificate",
  authProvider: "An auth provider",
  basic: "A password",
  none: "No credentials",
};
const signsInWith = computed(() => {
  if (props.cloud) return props.cloud.roleName ? `AWS · ${props.cloud.roleName} role` : "AWS";
  const auth = entry.value.auth;
  if (auth.kind === "exec") {
    const command = (auth.command ?? "An exec plugin").split(/[\\/]/).pop();
    return auth.awsProfile ? `${command} · profile ${auth.awsProfile}` : command;
  }
  return AUTH_TEXT[auth.kind] ?? auth.kind;
});

const file = computed(() =>
  entry.value.origin === "managed" ? "Added in JET Pilot" : entry.value.kubeConfig.replace(/^\/(home|Users)\/[^/]+/, "~")
);
const inferred = computed(() => (meta.value.envInferred ? envInfo(meta.value.env) : undefined));

const copy = (text: string, what: string) =>
  writeText(text).then(() => toast({ title: `${what} copied` }), () => undefined);
</script>

<template>
  <aside
    class="flex max-h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-sm"
    :aria-label="`Details of ${meta.displayName}`"
  >
    <div class="space-y-4 p-5">
      <div class="flex items-start gap-3">
        <ContextAvatar :name="entry.context" :kube-config="entry.kubeConfig" size="lg" />
        <div class="min-w-0 flex-1 pt-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <h2 class="truncate text-base font-semibold">{{ meta.displayName }}</h2>
            <EnvBadge v-if="meta.env && !meta.envInferred" :env="meta.env" />
          </div>
          <p class="truncate text-xs text-muted-foreground">{{ subtitle }}</p>
        </div>
        <Button variant="ghost" size="icon-sm" class="-mr-2 -mt-1 text-muted-foreground" aria-label="Close details" @click="emit('close')">
          <X class="h-4 w-4" />
        </Button>
      </div>

      <div class="flex items-center gap-2">
        <Button v-if="!cluster.active" class="flex-1" @click="emit('connect')">Connect</Button>
        <Button v-else variant="outline" class="flex-1" @click="emit('disconnect')">Disconnect</Button>
        <Button variant="outline" @click="emit('edit')">Edit</Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal class="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuItem v-if="!cluster.active" @select="emit('addToActive')">Add to active clusters</DropdownMenuItem>
            <DropdownMenuItem @select="emit('favorite')">{{ meta.favorite ? "Remove from favourites" : "Add to favourites" }}</DropdownMenuItem>
            <DropdownMenuItem @select="emit('hide')">{{ meta.hidden ? "Show in lists" : "Hide" }}</DropdownMenuItem>
            <DropdownMenuItem :disabled="entry.auth.interactive === 'interactive'" @select="emit('check')">Check status</DropdownMenuItem>
            <template v-if="entry.origin === 'managed'">
              <DropdownMenuSeparator />
              <DropdownMenuItem @select="emit('export')">Export…</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @select="emit('remove')">Remove from JET Pilot…</DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <div class="min-h-0 flex-1 space-y-5 overflow-y-auto border-t px-5 py-4">
      <button
        v-if="inferred"
        type="button"
        class="flex w-full items-start gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors duration-fast hover:bg-muted focus-ring"
        @click="emit('edit')"
      >
        <Sparkles class="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          Looks like <span class="font-medium text-foreground">{{ inferred.label.toLowerCase() }}</span>. Set its
          environment to colour it and turn on guardrails.
        </span>
      </button>

      <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
        <dt class="text-muted-foreground">Status</dt>
        <dd class="min-w-0">
          <span class="flex items-center gap-2"><StatusDot :tone="tone" /> {{ statusLine }}</span>
          <span v-if="statusDetail" class="block text-xs text-muted-foreground">{{ statusDetail }}</span>
        </dd>

        <template v-if="status?.serverVersion">
          <dt class="text-muted-foreground">Kubernetes</dt>
          <dd class="font-mono text-xs leading-5">{{ status.serverVersion }}</dd>
        </template>
        <template v-if="status?.nodeCount != null">
          <dt class="text-muted-foreground">Nodes</dt>
          <dd class="tabular-nums">{{ status.nodeCount }}</dd>
        </template>

        <dt class="text-muted-foreground">Signs in with</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="truncate">{{ signsInWith }}</span>
          <CredentialBadge :context="entry.context" :kube-config="entry.kubeConfig" size="sm" />
        </dd>

        <template v-if="cloud">
          <dt class="text-muted-foreground">Account</dt>
          <dd class="truncate">
            {{ cloud.accountName ?? cloud.accountId }}
            <span class="font-mono text-xs text-muted-foreground">{{ cloud.accountId }}</span>
          </dd>
        </template>
      </dl>

      <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t pt-4 text-sm">
        <template v-if="entry.server">
          <dt class="text-muted-foreground">Server</dt>
          <dd class="group/copy flex min-w-0 items-center gap-1">
            <span class="truncate font-mono text-xs leading-5" :title="entry.server">{{ entry.server }}</span>
            <button type="button" class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-ring group-hover/copy:opacity-100" aria-label="Copy server" @click="copy(entry.server!, 'Server')">
              <Copy class="h-3 w-3" />
            </button>
          </dd>
        </template>
        <dt class="text-muted-foreground">Context</dt>
        <dd class="group/copy flex min-w-0 items-center gap-1">
          <span class="truncate font-mono text-xs leading-5" :title="entry.context">{{ entry.context }}</span>
          <button type="button" class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-ring group-hover/copy:opacity-100" aria-label="Copy context name" @click="copy(entry.context, 'Context name')">
            <Copy class="h-3 w-3" />
          </button>
        </dd>
        <template v-if="entry.namespace">
          <dt class="text-muted-foreground">Namespace</dt>
          <dd class="truncate">{{ entry.namespace }}</dd>
        </template>
        <dt class="text-muted-foreground">Kubeconfig</dt>
        <dd class="truncate text-xs leading-5 text-muted-foreground" :title="entry.kubeConfig">
          {{ file }}<template v-if="entry.origin !== 'managed' && ORIGIN_LABELS[entry.origin as keyof typeof ORIGIN_LABELS]"> · {{ ORIGIN_LABELS[entry.origin as keyof typeof ORIGIN_LABELS] }}</template>
        </dd>
      </dl>

      <dl
        v-if="meta.folder || meta.tags.length || meta.protected || meta.readOnly"
        class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t pt-4 text-sm"
      >
        <template v-if="meta.folder">
          <dt class="text-muted-foreground">Folder</dt>
          <dd class="truncate">{{ meta.folder }}</dd>
        </template>
        <template v-if="meta.tags.length">
          <dt class="text-muted-foreground">Tags</dt>
          <dd class="flex flex-wrap gap-1">
            <span v-for="tag in meta.tags" :key="tag" class="rounded-md bg-muted px-1.5 py-0.5 text-xs">{{ tag }}</span>
          </dd>
        </template>
        <template v-if="meta.protected || meta.readOnly">
          <dt class="text-muted-foreground">Guardrails</dt>
          <dd class="space-y-1">
            <p v-if="meta.protected" class="flex items-center gap-1.5"><ShieldAlert class="h-3.5 w-3.5 text-destructive" /> Protected</p>
            <p v-if="meta.readOnly" class="flex items-center gap-1.5"><Lock class="h-3.5 w-3.5 text-warning" /> Read-only</p>
          </dd>
        </template>
      </dl>
    </div>
  </aside>
</template>
