<script setup lang="ts">
import NavigationItem from "@/components/settings/NavigationItem.vue";
import { Palette, ScrollText, Server, SlidersHorizontal } from "lucide-vue-next";
</script>
<template>
  <nav class="flex flex-col gap-0.5" aria-label="Settings sections">
    <NavigationItem
      :to="{ name: 'SettingsGeneral' }"
      title="General"
      :icon="SlidersHorizontal"
    />
    <NavigationItem
      :to="{ name: 'SettingsAppearance' }"
      title="Appearance"
      :icon="Palette"
    />
    <NavigationItem
      :to="{ name: 'SettingsClusters' }"
      title="Clusters"
      :icon="Server"
    />
    <NavigationItem :to="{ name: 'SettingsLogs' }" title="Logs" :icon="ScrollText" />
  </nav>
</template>
