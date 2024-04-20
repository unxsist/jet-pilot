<script setup lang="ts">
import NavigationItem from "@/components/settings/NavigationItem.vue";
</script>
<template>
  <nav class="flex flex-col space-y-1">
    <NavigationItem :to="{ name: 'SettingsGeneral' }" title="General" />
    <NavigationItem :to="{ name: 'SettingsAppearance' }" title="Appearance" />
    <NavigationItem :to="{ name: 'SettingsClusters' }" title="Clusters" />
  </nav>
</template>
