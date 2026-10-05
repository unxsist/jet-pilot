<script lang="ts" setup>
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink, Info, Megaphone, TriangleAlert } from "lucide-vue-next";
import { type Announcement, pendingAnnouncements } from "@/lib/announcements";
import { renderRemoteMarkdown } from "@/lib/markdown";
import { injectStrict } from "@/lib/utils";
import { warn } from "@/lib/logger";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

/*
 * Shows announcements from jet-pilot.app (see src/lib/announcements.ts) one
 * at a time, most severe first. Fetched on every launch, independent of the
 * "check for updates on startup" setting: announcements are how we reach
 * versions that can't update themselves.
 */
const { settings } = injectStrict(SettingsContextStateKey);
const queue = ref<Announcement[]>([]);
const current = computed(() => queue.value[0] ?? null);
const bodyHtml = ref("");

const dismissed = () => {
  const ids = settings.value.updates.dismissedAnnouncements;
  return Array.isArray(ids) ? ids : [];
};

watch(current, async (announcement) => {
  bodyHtml.value = "";
  if (!announcement) return;
  const html = await renderRemoteMarkdown(announcement.body);
  if (current.value?.id === announcement.id) {
    bodyHtml.value = html;
  }
});

function dismiss() {
  const announcement = current.value;
  if (!announcement) return;
  // Critical announcements come back on the next launch.
  if (announcement.severity !== "critical") {
    settings.value.updates.dismissedAnnouncements = [
      ...dismissed().filter((id) => id !== announcement.id),
      announcement.id,
    ];
  }
  queue.value = queue.value.slice(1);
}

onMounted(async () => {
  try {
    const [feed, version] = await Promise.all([
      invoke<unknown>("fetch_announcements"),
      getVersion(),
    ]);
    queue.value = pendingAnnouncements(feed, {
      version,
      platform: getOsType(),
      dismissed: dismissed(),
    });
  } catch (e) {
    // Offline or the site is down: nothing to announce.
    warn(`Announcements unavailable: ${e instanceof Error ? e.message : e}`);
  }
});
</script>
<template>
  <Dialog
    :open="current !== null"
    @update:open="(open: boolean) => !open && dismiss()"
  >
    <DialogContent v-if="current" class="max-w-lg">
      <div class="grid gap-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface-1 shadow-xs"
          >
            <TriangleAlert
              v-if="current.severity === 'critical'"
              class="h-5 w-5 text-destructive"
            />
            <TriangleAlert
              v-else-if="current.severity === 'warning'"
              class="h-5 w-5 text-warning"
            />
            <Megaphone v-else class="h-5 w-5 text-primary" />
          </span>
          <DialogHeader>
            <DialogTitle>{{ current.title }}</DialogTitle>
          </DialogHeader>
        </div>
        <div
          class="announcement-body max-h-72 overflow-y-auto rounded-lg border bg-surface-1 px-4 py-3 text-sm text-muted-foreground"
          v-html="bodyHtml"
        ></div>
        <p
          v-if="current.severity === 'critical'"
          class="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Info class="h-3.5 w-3.5" />
          This message is shown on every launch until it no longer applies.
        </p>
        <DialogFooter>
          <Button
            v-if="current.link"
            variant="outline"
            @click="openExternal(current.link.url)"
          >
            <ExternalLink class="h-3.5 w-3.5" />
            {{ current.link.label }}
          </Button>
          <Button @click="dismiss">
            {{ current.severity === "critical" ? "OK" : "Dismiss" }}
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style lang="postcss">
.announcement-body {
  p + p,
  p + ul,
  ul + p,
  pre + p,
  p + pre {
    @apply mt-2;
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
    @apply rounded bg-muted px-1 font-mono text-xs text-foreground;
  }

  pre {
    @apply overflow-x-auto rounded bg-muted px-2 py-1;

    code {
      @apply bg-transparent px-0;
    }
  }
}
</style>
