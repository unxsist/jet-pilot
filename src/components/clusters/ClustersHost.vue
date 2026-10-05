<script setup lang="ts">
/*
 * The add-cluster dialog (openAddCluster()) and the vault passphrase prompt
 * (withVault()), wherever they are asked for. Mounted once in App.vue.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { addClusterRequest, promptUnlock, vaultPrompt, type VaultPrompt } from "@/lib/clusters/managed";
import { discoverKubeconfigs } from "@/lib/kubeconfigSources";

const AddClusterDialog = defineAsyncComponent(() => import("@/views/clusters/add/AddClusterDialog.vue"));
const VaultPassphraseDialog = defineAsyncComponent(() => import("@/components/vault/VaultPassphraseDialog.vue"));

const addOpen = ref(false);
watch(addClusterRequest, (request) => {
  if (request) addOpen.value = true;
});

/*
 * The backend asks for the passphrase when a credential is needed while the
 * vault is locked (e.g. connecting to an added cluster after a restart);
 * JET Pilot's kubeconfig changed: lists refresh.
 */
const unlisteners: UnlistenFn[] = [];
onMounted(async () => {
  try {
    unlisteners.push(
      await listen("vault://unlock-required", () => {
        if (!vaultPrompt.value) void promptUnlock();
      }),
      await listen("clusters://managed-changed", () => void discoverKubeconfigs(true))
    );
  } catch {
    /* no event bridge (unit tests) */
  }
});
onBeforeUnmount(() => unlisteners.forEach((stop) => stop()));

const finishPrompt = (prompt: VaultPrompt, ok: boolean) => {
  if (vaultPrompt.value === prompt) vaultPrompt.value = null;
  prompt.resolve(ok);
};
</script>

<template>
  <AddClusterDialog v-if="addClusterRequest" v-model:open="addOpen" :method="addClusterRequest.method" />
  <VaultPassphraseDialog
    v-if="vaultPrompt"
    :key="vaultPrompt.mode"
    :prompt="vaultPrompt"
    @done="(ok) => finishPrompt(vaultPrompt!, ok)"
  />
</template>
