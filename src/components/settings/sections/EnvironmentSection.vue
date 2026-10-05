<script setup lang="ts">
/*
 * Settings › Advanced › Environment: apps started from the Dock or a
 * launcher don't get your shell's environment, so JET Pilot reads an
 * allowlist of variables (PATH, KUBECONFIG, AWS_PROFILE, proxies...) from
 * your login shell when it starts (src-tauri/src/env_import.rs). Names only:
 * values are never shown.
 */
import { invoke } from "@tauri-apps/api/core";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsHint, settingsLabel, settingsRow } from "@/components/settings/styles";

interface EnvImportReport {
  shell?: string | null;
  imported: string[];
  durationMs: number;
  error?: string | null;
  managedBinDir: string;
}

const report = ref<EnvImportReport | null>(null);
const failed = ref<string | null>(null);
onMounted(() => {
  invoke<EnvImportReport | null>("env_import_report").then(
    (value) => (report.value = value),
    (e) => (failed.value = String(e))
  );
});
</script>

<template>
  <SettingsSection
    title="Environment"
    description="Variables taken over from your login shell, so tools find what your terminal finds"
  >
    <p v-if="failed" class="py-4 text-xs text-destructive">{{ failed }}</p>
    <template v-else-if="report">
      <div :class="settingsRow">
        <div class="min-w-0">
          <p :class="settingsLabel">Login shell</p>
          <p :class="[settingsHint, 'mt-0.5']">
            {{ report.shell ? `Read at startup in ${report.durationMs} ms` : "Not used on this platform" }}
          </p>
        </div>
        <p v-if="report.shell" class="truncate font-mono text-xs text-muted-foreground sm:text-right">{{ report.shell }}</p>
      </div>
      <div :class="settingsRow">
        <div class="min-w-0">
          <p :class="settingsLabel">Variables</p>
          <p :class="[settingsHint, 'mt-0.5']">Names only; values are never shown.</p>
        </div>
        <p class="font-mono text-xs leading-5 text-muted-foreground sm:max-w-[22rem] sm:text-right">
          <template v-if="report.imported.length">{{ report.imported.join("  ") }}</template>
          <span v-else class="font-sans">None</span>
        </p>
      </div>
      <div :class="settingsRow">
        <div class="min-w-0">
          <p :class="settingsLabel">Downloaded tools</p>
          <p :class="[settingsHint, 'mt-0.5']">Searched after your PATH.</p>
        </div>
        <p class="truncate font-mono text-xs text-muted-foreground sm:max-w-[22rem] sm:text-right" :title="report.managedBinDir">
          {{ report.managedBinDir }}
        </p>
      </div>
      <p v-if="report.error" class="flex items-start gap-1.5 py-3 text-xs text-warning">
        <span class="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        <span>
          Reading your login shell failed: {{ report.error }}. Tools may not be found when JET Pilot is started from the
          Dock or a launcher.
        </span>
      </p>
    </template>
    <p v-else class="py-4 text-xs text-muted-foreground">Loading…</p>
  </SettingsSection>
</template>
