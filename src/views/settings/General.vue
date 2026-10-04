<script setup lang="ts">
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock, settingsRow } from "@/components/settings/styles";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import KubeConfigListBox from "@/views/settings/general/KubeConfigListBox.vue";

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const { settings } = injectStrict(SettingsContextStateKey);
</script>
<template>
  <div class="space-y-6">
    <SettingsSection
      title="Application"
      description="Updates and the in-app terminal"
    >
      <FormField
        v-slot="{ componentField }"
        v-model="settings.updates.checkOnStartup"
        name="check-for-updates-on-startup"
      >
        <FormItem :class="settingsRow">
          <div class="space-y-1">
            <label
              for="check-for-updates-on-startup"
              class="text-sm font-medium leading-none"
            >
              Check for updates on startup
            </label>
            <p class="text-xs text-muted-foreground">
              Look for a new JET Pilot release every time the app starts
            </p>
          </div>
          <div class="flex sm:justify-end">
            <Switch
              id="check-for-updates-on-startup"
              :checked="settings.updates.checkOnStartup"
              v-bind="componentField"
              @update:checked="settings.updates.checkOnStartup = $event"
            />
          </div>
        </FormItem>
      </FormField>
      <FormField
        v-slot="{ componentField }"
        v-model="settings.shell.executable"
        name="shell-executable"
      >
        <FormItem :class="settingsRow">
          <div class="space-y-1">
            <FormLabel>Shell executable</FormLabel>
            <FormDescription>
              The default shell to use when opening a shell for a container
            </FormDescription>
          </div>
          <div>
            <FormControl>
              <Input
                type="text"
                class="font-mono text-xs"
                placeholder="Please specify a shell e.g. /bin/sh"
                v-bind="componentField"
              />
            </FormControl>
            <FormMessage />
          </div>
        </FormItem>
      </FormField>
    </SettingsSection>

    <SettingsSection title="Logs" description="Defaults for the log viewer">
      <FormField
        v-slot="{ componentField }"
        v-model="settings.logs.tail_lines"
        name="tail_lines"
      >
        <FormItem :class="settingsRow">
          <div class="space-y-1">
            <FormLabel>Default tail lines</FormLabel>
            <FormDescription>
              The amount of lines to tail when viewing logs
            </FormDescription>
          </div>
          <div class="flex sm:justify-end">
            <FormControl class="w-40">
              <NumberField v-bind="componentField">
                <NumberFieldContent>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldContent>
              </NumberField>
            </FormControl>
            <FormMessage />
          </div>
        </FormItem>
      </FormField>
    </SettingsSection>

    <SettingsSection
      title="Kubeconfigs"
      description="If you have additional kubeconfig files, you can specify these here."
    >
      <div :class="settingsBlock">
        <KubeConfigListBox v-model="settings.kubeConfigs" />
      </div>
    </SettingsSection>
  </div>
</template>
