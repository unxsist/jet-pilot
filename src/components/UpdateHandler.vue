<script lang="ts" setup>
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Logo from "@/assets/logo-64.png";
import { CircleCheck, Download, Loader2, RotateCw } from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

const { settings } = injectStrict(SettingsContextStateKey);
const open = ref(false);
const isLatest = ref(true);
const updateInfo = ref<Update | null>(null);
const isUpdating = ref(false);
const restart = ref(false);
const closeable = ref(true);

/*
 * Release notes come from the update server and are rendered with v-html, so
 * sanitize the generated HTML: no scripts, event handlers, javascript: URLs
 * or other active content can reach the webview (which has IPC access).
 * marked + DOMPurify are only loaded when there are notes to render.
 */
const releaseNotesHtml = ref("");

const renderReleaseNotes = async (body: string): Promise<string> => {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);

  const mdRenderer = new marked.Renderer();
  mdRenderer.link = function (this: typeof mdRenderer, { href, tokens }) {
    const text = this.parser.parseInline(tokens);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  const html = marked.parse(body, {
    renderer: mdRenderer,
    async: false,
  }) as string;

  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"],
  });
};

watch(
  () => updateInfo.value?.body ?? "",
  async (body) => {
    releaseNotesHtml.value = "";
    if (!body) {
      return;
    }
    const html = await renderReleaseNotes(body);
    // A newer check may have replaced the notes in the meantime.
    if ((updateInfo.value?.body ?? "") === body) {
      releaseNotesHtml.value = html;
    }
  }
);

async function checkForUpdates(forced = false) {
  updateInfo.value = await check();

  if (updateInfo.value?.available) {
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
  if (updateInfo.value?.available) {
    closeable.value = false;
    isUpdating.value = true;
    const update = await check();
    update?.downloadAndInstall();
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
    <DialogContent class="max-w-lg" :closeable="closeable">
      <div
        v-if="updateInfo && !isLatest && !restart && !isUpdating"
        class="grid gap-4"
      >
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
          <Button variant="ghost" @click="open = !open">Skip for now</Button>
          <Button @click="updateApp">
            <Download class="h-3.5 w-3.5" />
            Update now
          </Button>
        </DialogFooter>
      </div>
      <div v-else-if="isLatest && !restart" class="grid gap-4">
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
          <Button variant="outline" @click="open = !open">Close</Button>
        </DialogFooter>
      </div>
      <div v-else-if="updateInfo && isUpdating" class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
          </span>
          <DialogHeader>
            <DialogTitle
              >Updating JET Pilot to v{{ updateInfo.version }}</DialogTitle
            >
            <DialogDescription>
              Please wait while JET Pilot is being updated.
            </DialogDescription>
          </DialogHeader>
        </div>
      </div>
      <div v-else-if="restart" class="grid gap-4">
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
