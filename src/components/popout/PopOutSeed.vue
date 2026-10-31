<script setup lang="ts">
/*
 * Before KubeContextProvider reads them: the clusters and namespaces of a
 * pop-out window are the ones active when it opened (the main window may
 * switch away meanwhile). Pop-out windows never write settings, so this
 * only changes this window's copy.
 */
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import type { WindowPayload } from "@/lib/windows";

const props = defineProps<{ payload: WindowPayload }>();
const { settings } = injectStrict(SettingsContextStateKey);

const [primary] = props.payload.contexts;
if (primary) {
  settings.value.activeContexts = props.payload.contexts.map((c) => ({
    ...c,
    namespaces: [...c.namespaces],
  }));
  settings.value.lastContext = primary.context;
  settings.value.lastKubeConfig = primary.kubeConfig;
  settings.value.lastNamespace =
    primary.namespaces.length === 1 && primary.namespaces[0] !== "all"
      ? primary.namespaces[0]
      : "";
}
</script>
<template>
  <slot />
</template>
