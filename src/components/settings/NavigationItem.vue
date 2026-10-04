<script setup lang="ts">
import type { Component } from "vue";
import { RouteLocationRaw } from "vue-router";

const props = defineProps<{
  title: string;
  to: RouteLocationRaw;
  icon?: Component;
}>();
</script>
<template>
  <router-link
    :to="props.to"
    class="group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors duration-fast hover:bg-accent/70 hover:text-foreground focus-ring [&.router-link-active]:bg-accent [&.router-link-active]:font-medium [&.router-link-active]:text-foreground"
  >
    <component
      :is="icon"
      v-if="icon"
      class="h-4 w-4 shrink-0 [.router-link-active_&]:text-primary"
      :stroke-width="1.75"
    />
    <span>{{ title }}</span>
  </router-link>
</template>
