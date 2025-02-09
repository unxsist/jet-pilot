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
}, { deep: true });
</script>
<template>
  <div class=" space-y-8">
    <div>
      <h2 class="font-medium text-base mb-4">Logs</h2>
      <FormField
        v-slot="{ componentField }"
        v-model="settings.logLevel"
        name="log-level"
      >
        <FormItem>
          <FormLabel>Log level</FormLabel>
          <FormControl>
            <Select
              v-bind="componentField"
              @update:modelValue="handleLogLevelChange"
            >
              <SelectTrigger class="w-32">
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
          <FormDescription>
            The minimum log level to display in the application logs
          </FormDescription>
        </FormItem> 
      </FormField>
    </div>

    <div>
      <div class="flex items-center justify-between mb-4 space-x-2">
        <h2 class="font-medium text-base">Application Logs</h2>
        <Button 
          size="xs"
          variant="secondary"
          @click="handleSaveLogs"
        >
          Export Logs
        </button>
      </div>
      <div
        ref="logContainer"
        class="w-full h-[400px] p-4 font-mono text-sm bg-muted rounded-md 
               resize-none focus:outline-none overflow-y-auto whitespace-pre-wrap 
               select-text"
        v-html="logsAsHtml"
      />
    </div>
  </div>
</template>
