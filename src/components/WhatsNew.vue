<script setup lang="ts">
/*
 * What's New: shown once after updating to a new minor version (unless
 * turned off in Settings › General), never on a fresh install.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { injectStrict } from "@/lib/utils";
import {
  SettingsContextStateKey,
  SettingsFirstRunKey,
} from "@/providers/SettingsContextProvider";
import { getVersion } from "@tauri-apps/api/app";
import { Sparkles } from "lucide-vue-next";

// The slides (carousel + images) only load when the dialog is shown.
const WhatsNewSlides = defineAsyncComponent(() => import("./whats-new/WhatsNewSlides.vue"));

const { settings } = injectStrict(SettingsContextStateKey);
const firstRun = injectStrict(SettingsFirstRunKey);

const shouldShowWhatsNew = ref(false);
const currentVersion = ref<string | null>(null);

onMounted(async () => {
  const lastSeenVersion = settings.value.updates.whatsNew;
  currentVersion.value = await getVersion();

  // Patch releases don't bring new slides: only a new minor (or major)
  // version shows the dialog again.
  const minor = (version: string | null) => version?.split(".").slice(0, 2).join(".") ?? null;
  if (minor(lastSeenVersion) !== minor(currentVersion.value)) {
    // Turned off in Settings › General, or a fresh install (the setup guide
    // shows instead): remember the version without showing it.
    if (settings.value.updates.showWhatsNew && !firstRun.value) shouldShowWhatsNew.value = true;
    else settings.value.updates.whatsNew = currentVersion.value;
  }
});

const storeLatestWhatsNew = (open: boolean) => {
  if (!open) {
    settings.value.updates.whatsNew = currentVersion.value;
    shouldShowWhatsNew.value = false;
  }
};
</script>
<template>
  <Dialog :open="shouldShowWhatsNew" @update:open="storeLatestWhatsNew">
    <DialogContent class="max-w-2xl gap-0 p-0" @open-auto-focus.prevent>
      <DialogHeader class="px-6 pb-4 pt-5">
        <DialogTitle class="flex items-center gap-2">
          <Sparkles class="h-4 w-4 text-primary" />
          What's new in JET Pilot
          <span v-if="currentVersion" class="font-normal text-muted-foreground">{{ currentVersion }}</span>
        </DialogTitle>
      </DialogHeader>
      <WhatsNewSlides @done="storeLatestWhatsNew(false)" />
    </DialogContent>
  </Dialog>
</template>
