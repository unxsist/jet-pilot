<script lang="ts" setup>
import { marked } from "marked";

import {
  checkUpdate,
  installUpdate,
  UpdateResult,
} from "@tauri-apps/api/updater";
import { relaunch } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Logo from "@/assets/logo.png";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

const { settings } = injectStrict(SettingsContextStateKey);
const open = ref(false);
const isLatest = ref(true);
const updateInfo = ref<UpdateResult | null>(null);
const isUpdating = ref(false);
const restart = ref(false);
const closeable = ref(true);

const mdRenderer = new marked.Renderer();
mdRenderer.link = (href, title, text) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

async function checkForUpdates(forced = false) {
  updateInfo.value = await checkUpdate();

  if (updateInfo.value.shouldUpdate) {
    open.value = true;
    isLatest.value = false;
  } else {
    isLatest.value = true;
  }

  if (forced) {
    open.value = true;
  }
}

async function updateApp() {
  if (updateInfo.value?.shouldUpdate) {
    closeable.value = false;
    isUpdating.value = true;
    await installUpdate();
    isUpdating.value = false;
    restart.value = true;
  }
}

async function restartApp() {
  await relaunch();
}

onMounted(() => {
  const checkOnStartup = settings.value.updates.checkOnStartup;

  if (checkOnStartup) {
    checkForUpdates();
  }
});

listen("check_for_updates", () => {
  checkForUpdates(true);
});
</script>
<template>
  <Dialog :open="open" @update:open="open = !open">
    <DialogContent class="w-1/2" :closeable="closeable">
      <div
        v-if="updateInfo && !isLatest && !restart && !isUpdating"
        class="grid gap-4"
      >
        <div class="flex items-center">
          <img :src="Logo" alt="JET Pilot" class="w-16 mr-4" />
          <DialogHeader>
            <DialogTitle
              >Update available - v{{
                updateInfo.manifest?.version
              }}</DialogTitle
            >
            <DialogDescription>
              A new version of JET Pilot is available.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div class="text-sm">
          <div
            class="max-h-[100px] overflow-scroll release-notes"
            v-html="
              marked.parse(updateInfo.manifest?.body, {
                renderer: mdRenderer,
              })
            "
          ></div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="open = !open">Skip for now</Button>
          <Button @click="updateApp"> Update now </Button>
        </DialogFooter>
      </div>
      <div v-else-if="isLatest && !restart" class="grid gap-4">
        <div class="flex items-center">
          <img :src="Logo" alt="JET Pilot" class="w-16 mr-4" />
          <DialogHeader>
            <DialogTitle>JET Pilot is up-to-date</DialogTitle>
            <DialogDescription>
              No new updates for JET Pilot are available.
            </DialogDescription>
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="open = !open">Close</Button>
        </DialogFooter>
      </div>
      <div v-else-if="updateInfo && isUpdating" class="grid gap-4">
        <div class="flex items-center">
          <img :src="Logo" alt="JET Pilot" class="w-16 mr-4" />
          <DialogHeader>
            <DialogTitle
              >Updating JET Pilot to v{{
                updateInfo.manifest?.version
              }}</DialogTitle
            >
            <DialogDescription>
              Please wait while JET Pilot is being updated.
            </DialogDescription>
          </DialogHeader>
        </div>
      </div>
      <div v-else-if="restart" class="grid gap-4">
        <div class="flex items-center">
          <img :src="Logo" alt="JET Pilot" class="w-16 mr-4" />
          <DialogHeader>
            <DialogTitle>Update completed</DialogTitle>
            <DialogDescription>
              Please restart JET Pilot to apply the update.
            </DialogDescription>
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="restartApp">Restart</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style lang="postcss">
.release-notes {
  h2 {
    @apply hidden;
  }

  h3 {
    @apply font-bold my-2;
  }
}
</style>
