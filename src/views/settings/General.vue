<script setup lang="ts">
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
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
  <div class="max-w-2xl space-y-8">
    <div>
      <h2 class="font-medium text-base mb-4">Updates</h2>
      <FormField
        v-slot="{ componentField }"
        v-model="settings.updates.checkOnStartup"
        name="check-for-updates-on-startup"
      >
        <FormItem>
          <div class="flex flex-row items-center space-x-2">
            <Checkbox
              id="check-for-updates-on-startup"
              :checked="settings.updates.checkOnStartup"
              v-bind="componentField"
              @update:checked="settings.updates.checkOnStartup = $event"
            />
            <label
              for="check-for-updates-on-startup"
              class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Check for updates on startup
            </label>
          </div>
        </FormItem>
      </FormField>
    </div>
    <div>
      <h2 class="font-medium text-base mb-4">Shell</h2>
      <FormField
        v-slot="{ componentField }"
        v-model="settings.shell.executable"
        name="shell-executable"
      >
        <FormItem>
          <FormLabel>Shell executable</FormLabel>
          <FormControl>
            <Input
              type="text"
              placeholder="Please specify a shell e.g. /bin/sh"
              v-bind="componentField"
            />
          </FormControl>
          <FormDescription>
            The default shell to use when opening a shell for a container
          </FormDescription>
          <FormMessage />
        </FormItem>
      </FormField>
    </div>
    <div>
      <h2 class="font-medium text-base mb-4">Logs</h2>
      <FormField
        v-slot="{ componentField }"
        v-model="settings.logs.tail_lines"
        name="tail_lines"
      >
        <FormItem>
          <FormLabel>Default tail lines</FormLabel>
          <FormControl class="w-48">
            <NumberField v-bind="componentField">
              <NumberFieldContent>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldContent>
            </NumberField>
          </FormControl>
          <FormDescription>
            The amount of lines to tail when viewing logs
          </FormDescription>
          <FormMessage />
        </FormItem>
      </FormField>
    </div>
    <div>
      <h2 class="font-medium text-base">Kubeconfigs</h2>
      <p class="text-sm text-muted-foreground mb-4">
        If you have additional kubeconfig files, you can specify these here.
      </p>
      <KubeConfigListBox v-model="settings.kubeConfigs" />
    </div>
  </div>
</template>
