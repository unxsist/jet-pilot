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
import metadata from "@/components/whats-new/metadata.json";

const { settings } = injectStrict(SettingsContextStateKey);

const shouldShowWhatsNew = ref(false);
const currentVersion = ref<string | null>(null);
const whatsNewComponent = ref<any>(null);

onMounted(async () => {
  const lastSeenVersion = settings.value.updates.whatsNew;
  currentVersion.value = await getVersion();

  if (
    lastSeenVersion !== currentVersion.value &&
    Object.keys(metadata).includes(currentVersion.value)
  ) {
    whatsNewComponent.value = defineAsyncComponent(
      // eslint-disable-next-line security/detect-object-injection
      () =>
        import(
          `@/components/whats-new/${
            metadata[currentVersion.value as keyof typeof metadata]
          }.vue`
        )
    );

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
        <DialogTitle>What's new in JET Pilot {{ currentVersion }}</DialogTitle>
      </DialogHeader>
      <component :is="whatsNewComponent" />
    </DialogContent>
  </Dialog>
</template>
