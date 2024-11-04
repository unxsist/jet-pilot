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
    <DialogContent class="min-w-[700px]">
      <DialogHeader>
        <DialogTitle>What's new in JET Pilot</DialogTitle>
      </DialogHeader>
      <Updates />
    </DialogContent>
  </Dialog>
</template>
