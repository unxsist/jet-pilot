<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { Separator } from "@/components/ui/separator";
import Navigation from "@/components/settings/Navigation.vue";

const appVersion = ref("");

onMounted(() => {
  getVersion().then((version) => {
    appVersion.value = version;
  });
});
</script>
<template>
  <div class="space-y-6 pb-16 h-full overflow-auto">
    <div class="sticky top-0 bg-background p-10 pb-0">
      <div class="space-y-0.5">
        <h2 class="text-2xl font-bold tracking-tight">Settings</h2>
        <p class="text-muted-foreground">Fine-tune JET Pilot to your liking</p>
      </div>
      <Separator class="my-6" />
    </div>
    <div class="flex flex-row space-x-12 space-y-0 px-10">
      <aside class="w-[150px]">
        <Navigation class="sticky top-[145px]" />
      </aside>
      <div class="flex-1 max-w-full">
        <div class="space-y-6"><router-view /></div>
      </div>
    </div>
    <div class="text-xs text-muted-foreground absolute right-5 bottom-5">
      JET Pilot version: {{ appVersion }}
    </div>
  </div>
</template>
