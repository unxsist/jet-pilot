<script lang="ts" setup>
import { check, type DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import Logo from "@/assets/logo-64.png";
import {
  CircleAlert,
  CircleCheck,
  Download,
  Loader2,
  RotateCw,
} from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { error as logError } from "@/lib/logger";
import { renderRemoteMarkdown } from "@/lib/markdown";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

const DOWNLOAD_PAGE = "https://www.jet-pilot.app";

const { settings } = injectStrict(SettingsContextStateKey);
const open = ref(false);
/*
 * available: an update was found     updating: downloading + installing
 * latest:    nothing newer            restart:  installed, relaunch to apply
 * error:     the check or the update failed (updateError has the reason)
 */
const stage = ref<"available" | "latest" | "updating" | "restart" | "error">(
  "latest"
);
const updateInfo = ref<Update | null>(null);
const updateError = ref<{
  kind: "check" | "install";
  message: string;
} | null>(null);
const downloaded = ref(0);
const total = ref<number | null>(null);
const installing = ref(false);
const isMacOS = getOsType() === "macos";

const closeable = computed(() => stage.value !== "updating");
const progress = computed(() =>
  total.value ? Math.min(100, (downloaded.value / total.value) * 100) : null
);

/*
 * An unsigned app that still carries the quarantine flag is run from a
 * read-only copy by macOS (App Translocation), so the update can't replace it.
 */
const isReadOnlyLocation = computed(
  () =>
    isMacOS &&
    /read-only file system|os error 30/i.test(updateError.value?.message ?? "")
);

const releaseNotesHtml = ref("");

watch(
  () => updateInfo.value?.body ?? "",
  async (body) => {
    releaseNotesHtml.value = "";
    if (!body) {
      return;
    }
    const html = await renderRemoteMarkdown(body);
    // A newer check may have replaced the notes in the meantime.
    if ((updateInfo.value?.body ?? "") === body) {
      releaseNotesHtml.value = html;
    }
  }
);

// No closing (Escape, click outside) while the update is being installed.
function onOpenChange(value: boolean) {
  if (closeable.value) {
    open.value = value;
  }
}

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

async function checkForUpdates(forced = false) {
  try {
    updateInfo.value = await check();
  } catch (e) {
    logError(`Checking for updates failed: ${errorMessage(e)}`);
    // A failed check on startup stays silent; a manual check shows why.
    if (forced) {
      updateError.value = { kind: "check", message: errorMessage(e) };
      stage.value = "error";
      open.value = true;
    }
    return;
  }

  stage.value = updateInfo.value ? "available" : "latest";
  if (updateInfo.value || forced) {
    open.value = true;
  }
}

function onDownloadEvent(event: DownloadEvent) {
  switch (event.event) {
    case "Started":
      total.value = event.data.contentLength || null;
      break;
    case "Progress":
      downloaded.value += event.data.chunkLength;
      break;
    case "Finished":
      installing.value = true;
      break;
  }
}

async function updateApp() {
  stage.value = "updating";
  downloaded.value = 0;
  total.value = null;
  installing.value = false;
  updateError.value = null;

  try {
    // A fresh check: the update resource from an earlier check may be stale.
    const update = await check();
    if (!update) {
      stage.value = "latest";
      return;
    }
    updateInfo.value = update;
    // Only offer the restart once the new version is in place: relaunching
    // mid-download would bring the old version back.
    await update.downloadAndInstall(onDownloadEvent);
    stage.value = "restart";
  } catch (e) {
    logError(`Installing the update failed: ${errorMessage(e)}`);
    updateError.value = { kind: "install", message: errorMessage(e) };
    stage.value = "error";
  }
}

function retry() {
  if (updateError.value?.kind === "check") {
    checkForUpdates(true);
  } else {
    updateApp();
  }
}

async function restartApp() {
  await relaunch();
}

const formatMegabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

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
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="max-w-lg" :closeable="closeable">
      <div v-if="stage === 'available' && updateInfo" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <img :src="Logo" alt="JET Pilot" class="h-8 w-8" />
          </span>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2"
              >Update available
              <span
                class="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-link"
                >v{{ updateInfo.version }}</span
              ></DialogTitle
            >
            <DialogDescription>
              A new version of JET Pilot is available.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div
          class="release-notes max-h-60 overflow-y-auto rounded-lg border bg-surface-1 px-4 py-3 text-sm text-muted-foreground"
          v-html="releaseNotesHtml"
        ></div>
        <DialogFooter>
          <Button variant="ghost" @click="open = false">Skip for now</Button>
          <Button @click="updateApp">
            <Download class="h-3.5 w-3.5" />
            Update now
          </Button>
        </DialogFooter>
      </div>
      <div v-else-if="stage === 'latest'" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <img :src="Logo" alt="JET Pilot" class="h-8 w-8" />
          </span>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              JET Pilot is up to date
              <CircleCheck class="h-4 w-4 text-success" />
            </DialogTitle>
            <DialogDescription>
              No new updates for JET Pilot are available.
            </DialogDescription>
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="open = false">Close</Button>
        </DialogFooter>
      </div>
      <div v-else-if="stage === 'updating'" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
          </span>
          <DialogHeader>
            <DialogTitle
              >Updating JET Pilot<template v-if="updateInfo">
                to v{{ updateInfo.version }}</template
              ></DialogTitle
            >
            <DialogDescription>
              <template v-if="installing">Installing the update…</template>
              <template v-else-if="downloaded > 0">
                Downloading… {{ formatMegabytes(downloaded)
                }}<template v-if="total">
                  of {{ formatMegabytes(total) }}</template
                >
                MB
              </template>
              <template v-else>Please wait while the update downloads.</template>
            </DialogDescription>
          </DialogHeader>
        </div>
        <Progress
          v-if="progress !== null && !installing"
          :model-value="progress"
        />
      </div>
      <div v-else-if="stage === 'restart'" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <img :src="Logo" alt="JET Pilot" class="h-8 w-8" />
          </span>
          <DialogHeader>
            <DialogTitle>Update completed</DialogTitle>
            <DialogDescription>
              Please restart JET Pilot to apply the update.
            </DialogDescription>
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button @click="restartApp">
            <RotateCw class="h-3.5 w-3.5" />
            Restart
          </Button>
        </DialogFooter>
      </div>
      <div v-else-if="stage === 'error' && updateError" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <CircleAlert class="h-5 w-5 text-destructive" />
          </span>
          <DialogHeader>
            <DialogTitle>{{
              updateError.kind === "check"
                ? "Couldn't check for updates"
                : "The update couldn't be installed"
            }}</DialogTitle>
            <DialogDescription>
              JET Pilot is still on the version you were running.
            </DialogDescription>
          </DialogHeader>
        </div>
        <p
          class="break-words rounded-lg border bg-surface-1 px-4 py-3 font-mono text-xs text-destructive"
        >
          {{ updateError.message }}
        </p>
        <div
          v-if="isReadOnlyLocation"
          class="grid gap-2 text-sm text-muted-foreground"
        >
          <p>
            macOS is running JET Pilot from a read-only copy, so the update
            can't replace it. Move JET Pilot to your Applications folder, clear
            the quarantine flag and update again:
          </p>
          <code
            class="select-text rounded bg-muted px-2 py-1 font-mono text-xs text-foreground"
            >xattr -dr com.apple.quarantine "/Applications/JET Pilot.app"</code
          >
          <p>
            Installed with Homebrew? Run
            <code class="rounded bg-muted px-1 font-mono text-xs"
              >brew upgrade --cask --greedy unxsist/tap/jet-pilot</code
            >
            instead.
          </p>
        </div>
        <p v-else class="text-sm text-muted-foreground">
          Try again, or download the latest version from jet-pilot.app.
        </p>
        <DialogFooter>
          <Button variant="ghost" @click="openExternal(DOWNLOAD_PAGE)"
            >Download page</Button
          >
          <Button variant="outline" @click="open = false">Close</Button>
          <Button @click="retry">
            <RotateCw class="h-3.5 w-3.5" />
            Try again
          </Button>
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
    @apply mb-1 mt-3 text-sm font-semibold text-foreground first:mt-0;
  }

  ul {
    @apply list-disc space-y-0.5 pl-4;
  }

  a {
    @apply text-link underline-offset-2 hover:underline;
  }

  code {
    @apply rounded bg-muted px-1 font-mono text-xs;
  }
}
</style>
