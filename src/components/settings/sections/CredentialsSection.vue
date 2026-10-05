<script setup lang="ts">
/*
 * Settings › Advanced › Cluster credentials: where JET Pilot keeps the
 * credentials of clusters you add (system keychain, or an encrypted file
 * with a passphrase), its credential helper for kubectl in your own
 * terminal, and how to point your terminal at JET Pilot's kubeconfig.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, KeyRound, Lock, MoreHorizontal, SquareTerminal } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock, settingsHint, settingsLabel, settingsTile } from "@/components/settings/styles";
import { useToast } from "@/components/ui/toast";
import {
  changePassphrase,
  clustersPaths,
  errorMessage,
  helperStatus,
  lockVault,
  reinstallHelper,
  resetVault,
  promptUnlock,
  vaultStatus,
  type ClustersPaths,
  type HelperStatus,
  type VaultStatus,
} from "@/lib/clusters/managed";

const { toast } = useToast();
const windows = getOsType() === "windows";

const vault = ref<VaultStatus | null>(null);
const helper = ref<HelperStatus | null>(null);
const paths = ref<ClustersPaths | null>(null);
const loadError = ref<string | null>(null);

const load = async () => {
  try {
    [vault.value, helper.value, paths.value] = await Promise.all([vaultStatus(), helperStatus(), clustersPaths()]);
  } catch (e) {
    loadError.value = errorMessage(e);
  }
};
onMounted(load);

const keychainName =
  ({ macos: "macOS Keychain", windows: "Windows Credential Manager", linux: "Secret Service" } as Record<string, string>)[
    getOsType()
  ] ?? "System keychain";
const storageTitle = computed(() => {
  if (!vault.value) return "";
  if (vault.value.backend === "keychain") return `Stored in ${keychainName}`;
  if (vault.value.backend === "passphrase") return "Stored in an encrypted file";
  return "Not set up yet";
});
const storageHint = computed(() => {
  const status = vault.value;
  if (!status) return "";
  if (status.backend === "keychain") return "Protected by your login. Nothing is written in plain text.";
  if (status.backend === "passphrase") {
    const state = status.locked ? "Locked. JET Pilot asks for the passphrase when it needs it." : "Unlocked for this session.";
    return status.unlockCached ? `${state} Terminals can use it too.` : state;
  }
  return "Set up when you add your first cluster.";
});
const listRow = "flex min-h-14 items-center gap-3 rounded-lg px-3 py-2";

const snippet = computed(() => {
  if (!paths.value) return "";
  return windows
    ? `$env:KUBECONFIG = "$HOME\\.kube\\config;${paths.value.kubeconfig}"`
    : `export KUBECONFIG="$HOME/.kube/config:${paths.value.kubeconfig.replace(/^\/(home|Users)\/[^/]+/, "$HOME")}"`;
});
const copy = (text: string, title = "Copied") => writeText(text).then(() => toast({ title }), () => undefined);

const run = async (action: () => Promise<unknown>, done: string) => {
  try {
    await action();
    toast({ title: done, variant: "success" });
  } catch (e) {
    toast({ title: "That didn't work", description: errorMessage(e), variant: "destructive" });
  } finally {
    void load();
  }
};

const unlock = async () => {
  if (await promptUnlock()) toast({ title: "Unlocked", variant: "success" });
  void load();
};
const changing = ref(false);
const oldPass = ref("");
const newPass = ref("");
const change = () =>
  run(() => changePassphrase(oldPass.value, newPass.value), "Passphrase changed").then(() => {
    changing.value = false;
    oldPass.value = newPass.value = "";
  });
const resetOpen = ref(false);
</script>

<template>
  <SettingsSection
    title="Cluster credentials"
    description="Where the credentials of clusters you add are kept, and how to use them in your terminal"
  >
    <p v-if="loadError" class="py-4 text-sm text-destructive">{{ loadError }}</p>

    <div v-if="vault || helper" class="py-2">
      <div class="-mx-3 space-y-px" role="list" aria-label="Credential storage">
        <div v-if="vault" role="listitem" :class="listRow">
          <span :class="settingsTile"><KeyRound class="h-4 w-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">{{ storageTitle }}</p>
            <p
              v-if="!vault.keychainAvailable && vault.keychainProblem"
              class="flex items-start gap-1.5 text-xs text-warning"
            >
              <span class="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
              <span class="min-w-0">{{ vault.keychainProblem }}</span>
            </p>
            <p v-else class="truncate text-xs text-muted-foreground">{{ storageHint }}</p>
          </div>
          <template v-if="vault.backend === 'passphrase'">
            <Button v-if="vault.locked" size="sm" variant="outline" @click="unlock">Unlock…</Button>
            <Button v-else size="sm" variant="outline" @click="run(lockVault, 'Locked')">
              <Lock class="h-3.5 w-3.5" /> Lock
            </Button>
          </template>
          <DropdownMenu v-if="vault.backend === 'passphrase' || vault.initialized">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" class="-mr-1.5 text-muted-foreground" aria-label="More for stored credentials">
                <MoreHorizontal class="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuItem v-if="vault.backend === 'passphrase'" @select="changing = true">
                Change passphrase…
              </DropdownMenuItem>
              <DropdownMenuSeparator v-if="vault.backend === 'passphrase' && vault.initialized" />
              <DropdownMenuItem v-if="vault.initialized" variant="destructive" @select="resetOpen = true">
                Reset stored credentials…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <form v-if="changing" class="flex items-center gap-2 pb-3 pl-14 pr-3 pt-1" @submit.prevent="change">
          <Input v-model="oldPass" type="password" placeholder="Current passphrase" class="flex-1" aria-label="Current passphrase" />
          <Input v-model="newPass" type="password" placeholder="New (8+ characters)" class="flex-1" aria-label="New passphrase" />
          <Button size="sm" variant="ghost" type="button" @click="changing = false">Cancel</Button>
          <Button size="sm" type="submit" :disabled="!oldPass || newPass.length < 8">Change</Button>
        </form>

        <div v-if="helper" role="listitem" :class="listRow">
          <span :class="settingsTile"><SquareTerminal class="h-4 w-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">Credential helper</p>
            <p class="truncate text-xs text-muted-foreground" :title="helper.path">
              kubectl asks it for the credentials of clusters you added
            </p>
          </div>
          <span v-if="!helper.installed" class="flex shrink-0 items-center gap-1.5 text-xs text-warning">
            <span class="h-1.5 w-1.5 rounded-full bg-current" />
            Not installed
          </span>
          <span v-else-if="helper.version" class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            v{{ helper.version }}
          </span>
          <Button v-if="!helper.installed" size="sm" variant="outline" @click="run(reinstallHelper, 'Credential helper installed')">
            Install
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" class="-mr-1.5 text-muted-foreground" aria-label="More for the credential helper">
                <MoreHorizontal class="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuItem @select="run(reinstallHelper, 'Credential helper reinstalled')">Reinstall</DropdownMenuItem>
              <DropdownMenuItem @select="copy(helper.path, 'Path copied')">Copy its path</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>

    <div v-if="paths" :class="settingsBlock">
      <div class="min-w-0">
        <p :class="settingsLabel">Use these clusters in your own terminal</p>
        <p :class="[settingsHint, 'mt-0.5']">
          Add JET Pilot's kubeconfig to KUBECONFIG in your shell profile, or export clusters from the Clusters hub.
        </p>
      </div>
      <div class="flex items-center gap-2 rounded-lg bg-muted/60 py-1 pl-3 pr-1">
        <code class="min-w-0 flex-1 truncate font-mono text-xs" :title="snippet">{{ snippet }}</code>
        <Button size="icon-sm" variant="ghost" class="text-muted-foreground" aria-label="Copy" @click="copy(snippet, 'Copied to the clipboard')">
          <Copy class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  </SettingsSection>

  <AlertDialog v-model:open="resetOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Reset stored credentials?</AlertDialogTitle>
        <AlertDialogDescription>
          Every credential JET Pilot stored is deleted. Clusters you added stay listed, but you'll have to add them
          again before you can connect. Only do this when you forgot the passphrase.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="run(resetVault, 'Credentials reset')">
          Reset
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
