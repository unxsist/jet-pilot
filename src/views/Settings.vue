<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { useRoute } from "vue-router";
import Navigation from "@/components/settings/Navigation.vue";

const route = useRoute();

const appVersion = ref("");

onMounted(() => {
  getVersion().then((version) => {
    appVersion.value = version;
  });
});
</script>
<template>
  <!-- Full-bleed settings pages (the theme editor) bring their own layout. -->
  <div v-if="route.meta.fullBleed" class="h-full">
    <router-view />
  </div>
  <div v-else class="h-full overflow-auto">
    <div class="mx-auto flex max-w-5xl gap-10 px-10 py-8">
      <aside class="w-48 shrink-0">
        <div class="sticky top-8 space-y-6">
          <div class="space-y-1">
            <h1 class="text-xl font-semibold tracking-tight">Settings</h1>
            <p class="text-sm text-muted-foreground">
              Fine-tune JET Pilot to your liking
            </p>
          </div>
          <Navigation />
          <p class="px-2.5 text-xs tabular-nums text-muted-foreground">
            JET Pilot {{ appVersion ? `v${appVersion}` : "" }}
          </p>
        </div>
      </aside>
      <main class="min-w-0 flex-1 space-y-6 pb-16">
        <router-view />
      </main>
    </div>
  </div>
</template>
