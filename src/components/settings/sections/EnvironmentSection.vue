<script setup lang="ts">
/*
 * Settings › Advanced › Environment: apps started from the Dock or a
 * launcher don't get your shell's environment, so JET Pilot reads an
 * allowlist of variables (PATH, KUBECONFIG, AWS_PROFILE, proxies...) from
 * your login shell when it starts (src-tauri/src/env_import.rs). Names only:
 * values are never shown.
 */
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock } from "@/components/settings/styles";

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
    description="Variables JET Pilot took over from your login shell at startup, so kubectl and sign-in plugins find what your terminal finds."
  >
    <div :class="settingsBlock">
      <p v-if="failed" class="text-xs text-destructive">{{ failed }}</p>
      <template v-else-if="report">
        <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          <dt class="text-muted-foreground">Shell</dt>
          <dd class="font-mono">
            {{ report.shell || "Not used on this platform" }}
            <span v-if="report.shell" class="text-muted-foreground">· {{ report.durationMs }} ms</span>
          </dd>
          <dt class="text-muted-foreground">Variables</dt>
          <dd class="flex flex-wrap gap-1">
            <Badge v-for="name in report.imported" :key="name" variant="muted" size="sm" class="font-mono">
              {{ name }}
            </Badge>
            <span v-if="report.imported.length === 0" class="text-muted-foreground">None</span>
          </dd>
          <dt class="text-muted-foreground">Downloaded tools</dt>
          <dd class="truncate font-mono" :title="report.managedBinDir">
            {{ report.managedBinDir }}
            <span class="font-sans text-muted-foreground">(searched after your PATH)</span>
          </dd>
        </dl>
        <p v-if="report.error" class="flex items-start gap-1.5 text-xs text-warning">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
          Reading your login shell failed: {{ report.error }}. Tools may not be found when JET Pilot is started from the Dock or a launcher.
        </p>
      </template>
      <p v-else class="text-xs text-muted-foreground">Loading…</p>
    </div>
  </SettingsSection>
</template>
