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
import { cn } from "@/lib/utils";
import { errorMessage, openAddCluster } from "@/lib/clusters/managed";
import { discoverKubeconfigs } from "@/lib/kubeconfigSources";
import { relativeTime } from "@/lib/clusters/status";
import {
  CONNECTION_KIND_LABELS,
  CONNECTION_STATUS,
  deleteConnection,
  type CloudConnection,
} from "@/lib/clusters/cloud";
import { connectionScope, expiryText, regionsSummary } from "@/lib/clusters/cloudModel";
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

const TONE_CLASSES = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
} as const;

const canSignIn = (connection: CloudConnection) =>
  connection.kind === "sso" || (connection.kind === "profile" && connection.status !== "signedIn");

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
  <div class="space-y-3">
    <div v-if="connections === null" class="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> Loading your accounts…
    </div>

    <EmptyState
      v-else-if="connections.length === 0"
      :icon="CloudOff"
      title="No cloud accounts yet"
      description="Connect an AWS account and JET Pilot finds its EKS clusters in every region, keeps the list current and signs in for you."
    >
      <template #action>
        <Button size="sm" @click="openAddCluster('aws')"><Plus class="h-3.5 w-3.5" /> Connect AWS</Button>
      </template>
    </EmptyState>

    <template v-else>
      <div class="overflow-hidden rounded-lg border bg-card shadow-xs" role="list" aria-label="Cloud accounts">
        <div
          v-for="connection in connections"
          :key="connection.id"
          role="listitem"
          class="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,11rem)_minmax(0,10rem)_17rem] items-center gap-x-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
        >
          <span class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-1">
            <ProviderMark provider="aws" :size="20" />
          </span>
          <div class="min-w-0">
            <p class="flex items-center gap-2 text-sm font-medium">
              <span class="truncate">{{ connection.label }}</span>
              <span class="shrink-0 text-xs font-normal text-muted-foreground">{{ CONNECTION_KIND_LABELS[connection.kind] }}</span>
            </p>
            <p class="truncate font-mono text-2xs text-muted-foreground" :title="connection.identity ?? undefined">
              {{ connection.identity ?? connection.sso?.startUrl ?? connection.profile }}
            </p>
          </div>
          <div class="min-w-0 text-xs text-muted-foreground">
            <p class="truncate text-foreground">{{ connectionScope(connection) }}</p>
            <p class="truncate">{{ regionsSummary(connection.regions) }}</p>
          </div>
          <div class="min-w-0 text-xs text-muted-foreground">
            <p class="truncate">
              <span class="text-foreground">{{ counts(connection).added }} added</span>
              <template v-if="counts(connection).available"> · {{ counts(connection).available }} available</template>
            </p>
            <p v-if="counts(connection).removed" class="truncate text-warning">
              {{ counts(connection).removed }} no longer in AWS
            </p>
            <p v-else-if="catalogRefreshedAt" class="truncate">Checked {{ relativeTime(catalogRefreshedAt) }}</p>
          </div>
          <div class="flex items-center justify-end gap-2">
            <span
              :class="cn('inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium', TONE_CLASSES[CONNECTION_STATUS[connection.status].tone])"
              :title="connection.message ?? undefined"
            >
              {{ CONNECTION_STATUS[connection.status].label }}
              <template v-if="connection.status === 'signedIn' && expiryText(connection.expiresAt)">
                · {{ expiryText(connection.expiresAt) }}
              </template>
            </span>
            <Button
              v-if="canSignIn(connection) && connection.status !== 'signedIn'"
              size="sm"
              class="h-7"
              @click="signingIn = connection"
            >
              <LogIn class="h-3.5 w-3.5" /> Sign in
            </Button>
            <Button
              v-else
              size="sm"
              variant="ghost"
              class="h-7 text-muted-foreground"
              :disabled="refreshing"
              :aria-label="`Look for new clusters in ${connection.label}`"
              title="Look for new clusters"
              @click="refresh(connection)"
            >
              <RefreshCw class="h-3.5 w-3.5" :class="refreshing ? 'animate-spin' : ''" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="text-muted-foreground" :aria-label="`Actions for ${connection.label}`">
                  <MoreHorizontal class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-60">
                <DropdownMenuItem :disabled="refreshing" @select="refresh(connection)">Look for new clusters</DropdownMenuItem>
                <DropdownMenuItem v-if="canSignIn(connection)" @select="signingIn = connection">Sign in again</DropdownMenuItem>
                <DropdownMenuItem @select="openAddCluster('aws', { connectionId: connection.id })">
                  {{ connection.kind === "sso" ? "Accounts and regions…" : "Regions…" }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="text-destructive focus:text-destructive" @select="removing = connection">
                  Remove…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4">
        <p class="text-xs text-muted-foreground">
          JET Pilot looks for new clusters when you open the hub, at most every 30 minutes, and never signs in by itself.
        </p>
        <Button size="sm" variant="outline" @click="openAddCluster('aws')"><Plus class="h-3.5 w-3.5" /> Connect an account</Button>
      </div>
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
        <label v-if="removing && counts(removing).added" class="flex items-center gap-2 text-sm">
          <Checkbox v-model:checked="removeClusters" />
          Also remove its {{ counts(removing).added }} {{ counts(removing).added === 1 ? "cluster" : "clusters" }} from JET Pilot (they can't sign in without it)
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
