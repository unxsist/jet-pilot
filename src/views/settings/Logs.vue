<script setup lang="ts">
import {
  FormField,
  FormItem,
  FormControl,
  FormDescription,
  FormLabel,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { invoke } from "@tauri-apps/api/core";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from "@tauri-apps/plugin-fs";

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { ref, watch, nextTick, computed } from 'vue';
import { useLogViewer } from '@/composables/useLogViewer';
import { AnsiUp } from 'ansi_up';
import Button from "@/components/ui/button/Button.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock, settingsRow } from "@/components/settings/styles";
import { Download } from "lucide-vue-next";

const { settings } = injectStrict(SettingsContextStateKey);
const { logs } = useLogViewer();

const logLevels = [
  { value: "trace", label: "Trace" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

const handleLogLevelChange = async (value: string) => {
  console.log('handleLogLevelChange', value);
  try {
    await invoke('update_log_level', { level: value });
  } catch (error) {
    console.error('Failed to update log level:', error);
  }
};

const handleSaveLogs = async () => {
  // Turn logs into plain text
  const logsPlain = logs.value
    .map(log => {
      const timestamp = new Date(log.timestamp).toLocaleTimeString();
      return `[${timestamp}] ${log.level.toUpperCase()} ${log.message}`;
    })
    .join('\n');

  try {
    const filePath = await save({
      title: 'Save Logs',
      filters: [{ name: 'Log File', extensions: ['log'] }],
    });
    if (filePath) {
      await writeTextFile(filePath, logsPlain);
      console.log('Logs saved to', filePath);
    }
  } catch (error) {
    console.error('Failed to save logs:', error);
  }
};

const logContainer = ref<HTMLDivElement | null>(null);
const ansiUp = new AnsiUp();

const logsAsHtml = computed(() => 
  logs.value
    .map((log) => {
      const timestamp = new Date(log.timestamp).toLocaleTimeString();
      const line = `[${timestamp}] ${log.level.toUpperCase()} ${log.message}`;
      return ansiUp.ansi_to_html(line);
    })
    .join('<br>')
);

watch(logs, () => {
  if (!logContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logContainer.value;
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 2;
  if (isAtBottom) {
    nextTick(() => {
      logContainer.value!.scrollTop = logContainer.value!.scrollHeight;
    });
  }
});
</script>
<template>
  <div class="space-y-6">
    <SettingsSection
      title="Logging"
      description="What JET Pilot writes to its own application log"
    >
      <FormField
        v-slot="{ componentField }"
        v-model="settings.logLevel"
        name="log-level"
      >
        <FormItem :class="settingsRow">
          <div class="space-y-1">
            <FormLabel>Log level</FormLabel>
            <FormDescription>
              The minimum log level to display in the application logs
            </FormDescription>
          </div>
          <div class="flex sm:justify-end">
            <FormControl>
              <Select
                v-bind="componentField"
                @update:modelValue="handleLogLevelChange"
              >
                <SelectTrigger class="w-36">
                  <SelectValue placeholder="Select level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="level in logLevels"
                    :key="level.value"
                    :value="level.value"
                  >
                    {{ level.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
          </div>
        </FormItem>
      </FormField>
    </SettingsSection>

    <SettingsSection
      title="Application logs"
      description="Live output of the JET Pilot backend"
    >
      <template #actions>
        <Button size="sm" variant="outline" @click="handleSaveLogs">
          <Download class="h-3.5 w-3.5" />
          Export logs
        </Button>
      </template>
      <div :class="settingsBlock">
        <div
          ref="logContainer"
          class="h-[400px] w-full overflow-y-auto whitespace-pre-wrap rounded-md border bg-surface-1 p-3 font-mono text-xs leading-5 text-foreground select-text focus:outline-none"
          v-html="logsAsHtml"
        />
      </div>
    </SettingsSection>
  </div>
</template>
