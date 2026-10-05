<script setup lang="ts">
/*
 * Shows the setup guide on a fresh install (until finished or skipped), or
 * when asked for (palette: "Open setup guide").
 */
import { injectStrict } from "@/lib/utils";
import {
  SettingsContextStateKey,
  SettingsFirstRunKey,
} from "@/providers/SettingsContextProvider";
import { welcomeRequested } from "@/lib/welcome";

const WelcomeFlow = defineAsyncComponent(() => import("@/components/welcome/WelcomeFlow.vue"));

const { settings } = injectStrict(SettingsContextStateKey);
const firstRun = injectStrict(SettingsFirstRunKey);

const visible = computed(
  () => welcomeRequested.value || (firstRun.value && !settings.value.welcomeCompleted)
);

const finish = async () => {
  welcomeRequested.value = false;
  const { getVersion } = await import("@tauri-apps/api/app");
  settings.value.welcomeCompleted = await getVersion().catch(() => "unknown");
};
</script>

<template>
  <WelcomeFlow v-if="visible" @finish="finish" />
</template>
