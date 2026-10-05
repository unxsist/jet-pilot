<script setup lang="ts">
/*
 * Route shell of the theme editor. The router (startup bundle) lists the
 * files every lazy route preloads; the editor's list is long (Monaco, the
 * theme engine, dialogs), so it lives in this small chunk instead.
 */
import Loading from "@/components/Loading.vue";

const ThemeEditor = defineAsyncComponent({
  loader: () => import("./ThemeEditor.vue"),
  loadingComponent: Loading,
  delay: 150,
});
</script>

<template>
  <ThemeEditor />
</template>
