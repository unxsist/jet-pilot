<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { getVersion } from "@tauri-apps/api/app";
import Updates from "./whats-new/Updates.vue";
import { Sparkles } from "lucide-vue-next";

const { settings } = injectStrict(SettingsContextStateKey);

const shouldShowWhatsNew = ref(false);
const currentVersion = ref<string | null>(null);

onMounted(async () => {
  const lastSeenVersion = settings.value.updates.whatsNew;
  currentVersion.value = await getVersion();

  if (lastSeenVersion !== currentVersion.value) {
    shouldShowWhatsNew.value = true;
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
    <DialogContent class="min-w-[700px] gap-5">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Sparkles class="h-4 w-4 text-primary" />
          What's new in JET Pilot
          <span
            v-if="currentVersion"
            class="rounded-full border px-2 py-0.5 font-mono text-xs font-medium text-muted-foreground"
            >v{{ currentVersion }}</span
          >
        </DialogTitle>
      </DialogHeader>
      <Updates />
    </DialogContent>
  </Dialog>
</template>
