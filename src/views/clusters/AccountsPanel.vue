<script setup lang="ts">
/**
 * The hub's Accounts tab: the cloud accounts JET Pilot is connected to, how
 * they sign in and until when, what they reach, and their clusters. Sign in
 * again, look for new clusters, change accounts and regions, or remove.
 */
import { CloudOff, Loader2, LogIn, MoreHorizontal, Plus, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import ConnectionSignInDialog from "./ConnectionSignInDialog.vue";
import { errorMessage, openAddCluster } from "@/lib/clusters/managed";
import { discoverKubeconfigs } from "@/lib/kubeconfigSources";
import { relativeTime } from "@/lib/clusters/status";
import {
  CONNECTION_STATUS,
  deleteConnection,
  type CloudConnection,
} from "@/lib/clusters/cloud";
import { connectionScope, expiryText, regionsSummary } from "@/lib/clusters/cloudModel";
import { connectionKindLabel, narrowLabel, providerInfo } from "@/lib/clusters/providers";
import { catalog, catalogRefreshedAt, connections, discovery, loadCloud, refreshCloud } from "@/lib/clusters/catalogStore";

const { toast } = useToast();

const counts = (connection: CloudConnection) => {
  const own = (catalog.value ?? []).filter((c) => c.connectionId === connection.id);
  return {
    added: own.filter((c) => c.state === "added").length,
    available: own.filter((c) => c.state === "available").length,
    removed: own.filter((c) => c.state === "removed").length,
  };
};

const DOT_CLASSES = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
} as const;

/* Signing in again: IAM Identity Center, AWS profiles that need it, gcloud and az. */
const canSignIn = (connection: CloudConnection) =>
  connection.kind === "sso" ||
  (connection.kind === "profile" && connection.status !== "signedIn") ||
  (connection.kind === "cli" && connection.provider !== "digitalocean");

const refreshing = computed(() => !!discovery.value);
const refresh = async (connection?: CloudConnection) => {
  try {
    const state = await refreshCloud(connection ? [connection.id] : null);
    const failed = state.scopes.filter((s) => s.state === "error");
    if (failed.length) {
      toast({
        title: `${failed.length} ${failed.length === 1 ? "place" : "places"} couldn't be checked`,
        description: failed.slice(0, 3).map((s) => `${s.scope}: ${s.message ?? "failed"}`).join("\n"),
        variant: "destructive",
      });
    }
  } catch (e) {
    toast({ title: "Couldn't look for clusters", description: errorMessage(e), variant: "destructive" });
  }
};

const signingIn = ref<CloudConnection | null>(null);

const removing = ref<CloudConnection | null>(null);
const removeClusters = ref(true);
const remove = async () => {
  const connection = removing.value;
  removing.value = null;
  if (!connection) return;
  try {
    await deleteConnection(connection.id, removeClusters.value);
    if (removeClusters.value) void discoverKubeconfigs(true);
    await loadCloud();
    toast({ title: `Removed ${connection.label}` });
  } catch (e) {
    toast({ title: "Couldn't remove the account", description: errorMessage(e), variant: "destructive" });
  }
};
watch(removing, () => (removeClusters.value = true));
</script>

<template>
  <div class="space-y-4">
    <div v-if="connections === null" class="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> Loading your accounts…
    </div>

    <EmptyState
      v-else-if="connections.length === 0"
      :icon="CloudOff"
      title="No cloud accounts yet"
      description="Connect AWS, Google Cloud, Azure, DigitalOcean or another cloud: JET Pilot finds its clusters, keeps the list current and signs in for you."
    >
      <template #action>
        <Button @click="openAddCluster('cloud')"><Plus class="h-4 w-4" /> Connect a cloud account</Button>
      </template>
    </EmptyState>

    <template v-else>
      <div class="grid gap-4 md:grid-cols-2" role="list" aria-label="Cloud accounts">
        <article
          v-for="connection in connections"
          :key="connection.id"
          role="listitem"
          class="flex flex-col rounded-xl border bg-card shadow-xs"
        >
          <div class="flex items-start gap-3 p-5 pb-4">
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-1">
              <ProviderMark :provider="connection.provider" :size="22" />
            </span>
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-base font-semibold">{{ connection.label }}</h3>
              <p class="truncate text-xs text-muted-foreground">{{ connectionKindLabel(connection) }}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="-mr-2 text-muted-foreground" :aria-label="`Actions for ${connection.label}`">
                  <MoreHorizontal class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-60">
                <DropdownMenuItem :disabled="refreshing || connection.status !== 'signedIn'" @select="refresh(connection)">
                  Look for new clusters
                </DropdownMenuItem>
                <DropdownMenuItem v-if="canSignIn(connection)" @select="signingIn = connection">Sign in again</DropdownMenuItem>
                <DropdownMenuItem
                  v-if="narrowLabel(connection)"
                  @select="openAddCluster('cloud', { provider: connection.provider, connectionId: connection.id })"
                >
                  {{ narrowLabel(connection) }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" @select="removing = connection">Remove…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div class="flex-1 space-y-3 px-5 pb-5">
            <div class="flex items-center justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2 text-sm" :title="connection.message ?? undefined">
                <span class="h-2 w-2 shrink-0 rounded-full" :class="DOT_CLASSES[CONNECTION_STATUS[connection.status].tone]" />
                <span class="truncate">
                  {{ CONNECTION_STATUS[connection.status].label }}
                  <span v-if="connection.status === 'signedIn' && expiryText(connection.expiresAt)" class="text-muted-foreground">
                    · {{ expiryText(connection.expiresAt) }}
                  </span>
                </span>
              </span>
              <Button v-if="canSignIn(connection) && connection.status !== 'signedIn'" size="sm" @click="signingIn = connection">
                <LogIn class="h-3.5 w-3.5" /> Sign in
              </Button>
            </div>
            <p class="text-sm text-muted-foreground">
              <span class="text-foreground">{{ connectionScope(connection) }}</span>
              <template v-if="providerInfo(connection.provider).regional"> · {{ regionsSummary(connection.regions) }}</template>
            </p>
            <p class="text-sm text-muted-foreground">
              <span class="text-foreground">{{ counts(connection).added }} {{ counts(connection).added === 1 ? "cluster" : "clusters" }}</span>
              <template v-if="counts(connection).available"> · {{ counts(connection).available }} new</template>
              <span v-if="counts(connection).removed" class="text-warning"> · {{ counts(connection).removed }} deleted in {{ providerInfo(connection.provider).name }}</span>
            </p>
          </div>

          <div class="flex items-center justify-between gap-3 border-t px-5 py-2.5 text-xs text-muted-foreground">
            <span class="truncate font-mono" :title="connection.identity ?? undefined">
              {{ connection.identity ?? connection.sso?.startUrl ?? connection.profile }}
            </span>
            <button
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring disabled:opacity-50"
              :disabled="refreshing || connection.status !== 'signedIn'"
              :aria-label="`Look for new clusters in ${connection.label}`"
              @click="refresh(connection)"
            >
              <RefreshCw class="h-3 w-3" :class="refreshing ? 'animate-spin' : ''" />
              <template v-if="catalogRefreshedAt">Checked {{ relativeTime(catalogRefreshedAt) }}</template>
              <template v-else>Look for clusters</template>
            </button>
          </div>
        </article>

        <button
          type="button"
          class="flex min-h-[12rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors duration-fast hover:border-border-strong hover:bg-accent/30 hover:text-foreground focus-ring"
          @click="openAddCluster('cloud')"
        >
          <Plus class="h-5 w-5" />
          Connect an account
        </button>
      </div>

      <p class="text-xs text-muted-foreground">
        JET Pilot looks for new clusters when you open the hub, at most every 30 minutes. It never signs in by itself.
      </p>
    </template>

    <ConnectionSignInDialog v-if="signingIn" :connection="signingIn" @close="signingIn = null" />

    <AlertDialog :open="!!removing" @update:open="(value) => !value && (removing = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {{ removing?.label }}?</AlertDialogTitle>
          <AlertDialogDescription>
            JET Pilot forgets this account and its stored sign-in. Nothing changes in AWS.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label v-if="removing && counts(removing).added" class="flex items-start gap-2.5 text-sm">
          <Checkbox v-model:checked="removeClusters" class="mt-0.5" />
          <span>
            Also remove its {{ counts(removing).added }} {{ counts(removing).added === 1 ? "cluster" : "clusters" }} from JET Pilot
            <span class="block text-xs text-muted-foreground">They can't sign in without the account.</span>
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="remove">
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
