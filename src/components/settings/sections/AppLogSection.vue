<script setup lang="ts">
/*
 * Settings › Advanced › Application log: live output of the JET Pilot
 * backend (the level is diagnostics.logLevel), exportable to a file for bug
 * reports.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useLogViewer } from "@/composables/useLogViewer";
import { AnsiUp } from "ansi_up";
import { Download } from "lucide-vue-next";
import Button from "@/components/ui/button/Button.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { useToast } from "@/components/ui/toast";
import { error } from "@/lib/logger";

const { logs } = useLogViewer();
const { toast } = useToast();

const plainLogs = () =>
  logs.value
    .map((log) => {
      const timestamp = new Date(log.timestamp).toLocaleTimeString();
      return `[${timestamp}] ${log.level.toUpperCase()} ${log.message}`;
    })
    .join("\n");

const exportLogs = async () => {
  try {
    const filePath = await save({
      title: "Export application log",
      defaultPath: "jet-pilot.log",
      filters: [{ name: "Log file", extensions: ["log"] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, plainLogs());
    toast({ title: "Application log exported", description: filePath, variant: "success" });
  } catch (e) {
    error(`Failed to export the application log: ${e}`);
    toast({ title: "Couldn't export the log", description: String(e), variant: "destructive" });
  }
};

const logContainer = ref<HTMLDivElement | null>(null);
const ansiUp = new AnsiUp();

const logsAsHtml = computed(() =>
  logs.value
    .map((log) => {
      const timestamp = new Date(log.timestamp).toLocaleTimeString();
      return ansiUp.ansi_to_html(`[${timestamp}] ${log.level.toUpperCase()} ${log.message}`);
    })
    .join("<br>")
);

/* Stick to the bottom while it is scrolled there. */
watch(logs, () => {
  const container = logContainer.value;
  if (!container) return;
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
  if (atBottom) nextTick(() => (container.scrollTop = container.scrollHeight));
});
</script>

<template>
  <SettingsSection title="Application log" description="Live output of the JET Pilot backend">
    <template #actions>
      <Button size="sm" variant="ghost" class="-mr-2 text-muted-foreground hover:text-foreground" @click="exportLogs">
        <Download class="h-3.5 w-3.5" />
        Export…
      </Button>
    </template>
    <div class="pt-4">
      <div
        ref="logContainer"
        class="h-[400px] w-full select-text overflow-y-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-1 px-3.5 py-3 font-mono text-xs leading-5 text-foreground focus:outline-none"
        v-html="logsAsHtml"
      />
    </div>
  </SettingsSection>
</template>
