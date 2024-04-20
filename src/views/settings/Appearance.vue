<script setup lang="ts">
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useColorMode } from "@vueuse/core";

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const { settings } = injectStrict(SettingsContextStateKey);
const colorMode = useColorMode();

watch(
  settings.value,
  (value) => {
    colorMode.value = value.appearance.colorScheme;
  },
  { deep: true }
);
</script>
<template>
  <div class="max-w-2xl">
    <FormField name="username">
      <FormItem>
        <FormLabel>Color Scheme</FormLabel>
        <FormControl>
          <Select v-model="settings.appearance.colorScheme">
            <SelectTrigger>
              <SelectValue placeholder="Select a color scheme" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="auto">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormControl>
        <FormDescription>
          Either light or dark, depending on your preference
        </FormDescription>
        <FormMessage />
      </FormItem>
    </FormField>
  </div>
</template>
