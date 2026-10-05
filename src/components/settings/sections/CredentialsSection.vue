<script setup lang="ts">
/*
 * Settings › Advanced › Cluster credentials: where JET Pilot keeps the
 * credentials of clusters you add (system keychain, or an encrypted file
 * with a passphrase), its credential helper for kubectl in your own
 * terminal, and how to point your terminal at JET Pilot's kubeconfig.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { CheckCircle2, CircleAlert, Copy, KeyRound, Lock, RefreshCw } from "lucide-vue-next";
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
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock, settingsRow } from "@/components/settings/styles";
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

const BACKENDS = { keychain: "System keychain", passphrase: "Encrypted file (passphrase)", none: "Not set up yet" } as const;
const keychainName = computed(() =>
  ({ macos: "macOS Keychain", windows: "Windows Credential Manager", linux: "Secret Service" })[getOsType() as "macos"] ??
  "System keychain"
);

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
    description="Where JET Pilot keeps the credentials of clusters you add, and how to use those clusters in your own terminal"
  >
    <p v-if="loadError" class="px-5 py-4 text-sm text-destructive">{{ loadError }}</p>

    <div v-if="vault" :class="settingsRow">
      <div class="space-y-1">
        <p class="flex items-center gap-2 text-sm font-medium">
          <KeyRound class="h-4 w-4 text-muted-foreground" />
          Stored in: {{ vault.backend === "keychain" ? keychainName : BACKENDS[vault.backend] }}
        </p>
        <p v-if="vault.backend === 'passphrase'" class="text-xs text-muted-foreground">
          {{ vault.locked ? "Locked. JET Pilot asks for the passphrase when it needs a credential." : "Unlocked for this session." }}
          <template v-if="vault.unlockCached"> Terminals can use it too.</template>
        </p>
        <p v-else-if="vault.backend === 'keychain'" class="text-xs text-muted-foreground">
          Protected by your login. Nothing is written to kubeconfig files in plain text.
        </p>
        <p v-if="!vault.keychainAvailable && vault.keychainProblem" class="flex items-start gap-1.5 text-xs text-warning">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
          {{ vault.keychainProblem }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2 sm:justify-end">
        <template v-if="vault.backend === 'passphrase'">
          <Button v-if="vault.locked" size="sm" variant="outline" @click="unlock">Unlock…</Button>
          <Button v-else size="sm" variant="outline" @click="run(lockVault, 'Locked')"><Lock class="h-3.5 w-3.5" /> Lock</Button>
          <Button size="sm" variant="ghost" @click="changing = !changing">Change passphrase</Button>
        </template>
        <Button v-if="vault.initialized" size="sm" variant="ghost" class="text-destructive" @click="resetOpen = true">Reset…</Button>
      </div>
    </div>
    <form v-if="changing" :class="settingsBlock" class="flex items-center gap-2" @submit.prevent="change">
      <Input v-model="oldPass" type="password" placeholder="Current passphrase" class="max-w-52" aria-label="Current passphrase" />
      <Input v-model="newPass" type="password" placeholder="New passphrase (8+ characters)" class="max-w-60" aria-label="New passphrase" />
      <Button size="sm" type="submit" :disabled="!oldPass || newPass.length < 8">Change</Button>
    </form>

    <div v-if="helper" :class="settingsRow">
      <div class="space-y-1">
        <p class="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 v-if="helper.installed" class="h-4 w-4 text-success" />
          <CircleAlert v-else class="h-4 w-4 text-warning" />
          Credential helper {{ helper.version ? `v${helper.version}` : "" }}
        </p>
        <p class="truncate font-mono text-2xs text-muted-foreground" :title="helper.path">{{ helper.path }}</p>
        <p class="text-xs text-muted-foreground">
          kubectl and other tools ask it for the credentials of clusters you added in JET Pilot.
        </p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="ghost" @click="run(reinstallHelper, 'Credential helper reinstalled')">
          <RefreshCw class="h-3.5 w-3.5" /> Reinstall
        </Button>
      </div>
    </div>

    <div v-if="paths" :class="settingsBlock">
      <p class="text-sm font-medium">Use these clusters in your own terminal</p>
      <p class="text-xs text-muted-foreground">
        JET Pilot keeps clusters you add in <span class="font-mono">{{ paths.kubeconfig }}</span>. Add it to
        KUBECONFIG in your shell profile, or export clusters into ~/.kube/config from the Clusters hub.
      </p>
      <div class="flex items-center gap-2 rounded-md border bg-surface-1 py-1 pl-3 pr-1">
        <code class="min-w-0 flex-1 truncate font-mono text-xs" :title="snippet">{{ snippet }}</code>
        <Button size="icon-sm" variant="ghost" aria-label="Copy" @click="copy(snippet, 'Copied to the clipboard')">
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
