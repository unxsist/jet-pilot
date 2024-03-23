<script setup lang="ts">
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const { settings } = injectStrict(SettingsContextStateKey);
</script>
<template>
  <div class="max-w-2xl">
    <FormField
      v-slot="{ componentField }"
      v-model="settings.shell.executable"
      name="username"
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
</template>
