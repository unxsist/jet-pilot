<script setup lang="ts">
/*
 * Settings › Appearance › Add a theme: drop files, pick files, paste JSON,
 * start a new theme or open the themes folder. Every path runs through the
 * importer and shows what it found (ThemeInstallDialog) before installing.
 *
 * Dropping files: Tauri handles OS file drops itself (dragDropEnabled is on
 * by default), so the webview gets paths through onDragDropEvent; the fs
 * plugin adds dropped paths to the fs scope, so readTextFile works on them.
 * Plain HTML5 drops (the browser harness) read the File objects instead.
 * Either way the whole page accepts the drop while it is open.
 */
import { useRouter } from "vue-router";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ClipboardPaste, FileUp, FolderOpen, Loader2, Plus, Upload } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import ThemeInstallDialog from "./ThemeInstallDialog.vue";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useTheme } from "@/providers/ThemeProvider";
import { THEME_FILE_EXTENSIONS } from "@/lib/themes/library";
import type { ThemeFile } from "@/lib/themes/types";
import {
  errorMessage,
  importSources,
  readThemeBlobs,
  readThemePaths,
  type ImportReport,
  type ImportSource,
} from "./shared";

const theme = useTheme();
const router = useRouter();
const { toast } = useToast();

/* ------------------------------------------------------ import flow -- */

const report = ref<ImportReport | null>(null);
const reportOpen = ref(false);
const reportTitle = ref("Import themes");
const reading = ref(false);
const installing = ref(false);

const showReport = async (
  sources: ImportSource[],
  errors: ImportReport["errors"] = [],
  title = "Import themes"
) => {
  reading.value = true;
  try {
    const result = await importSources(sources);
    report.value = { ...result, errors: [...errors, ...result.errors] };
    reportTitle.value = title;
    reportOpen.value = true;
  } finally {
    reading.value = false;
  }
};

const install = async (files: ThemeFile[]) => {
  installing.value = true;
  try {
    const entries = await theme.install(files, "user");
    reportOpen.value = false;
    toast({
      title: entries.length === 1 ? `Installed ${entries[0]!.name}` : `Installed ${entries.length} themes`,
      description: "Find them under Your themes.",
      variant: "success",
    });
  } catch (e) {
    toast({ title: "Couldn't install the themes", description: errorMessage(e), variant: "destructive" });
  } finally {
    installing.value = false;
  }
};

/* ---------------------------------------------------- import file… -- */

const importFiles = async () => {
  const picked = await openDialog({
    multiple: true,
    title: "Import themes",
    filters: [
      { name: "Themes", extensions: [...THEME_FILE_EXTENSIONS] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  const { sources, errors } = await readThemePaths(paths);
  await showReport(sources, errors);
};

/* ------------------------------------------------------ paste JSON -- */

const pasteOpen = ref(false);
const pasted = ref("");
const pasteError = ref("");
watch(pasted, () => (pasteError.value = ""));
const importPasted = async () => {
  const text = pasted.value;
  if (!text.trim()) return;
  // The importer sniffs the format; the name only breaks ties.
  const name = /^\s*</.test(text) ? "Pasted.tmTheme" : "Pasted JSON";
  reading.value = true;
  try {
    const result = await importSources([{ name, text }]);
    if (!result.themes.length) {
      // Fix it in place rather than in a second dialog.
      pasteError.value = result.errors[0]?.message ?? "No theme found in the text.";
      return;
    }
    pasteOpen.value = false;
    pasted.value = "";
    report.value = result;
    reportTitle.value = "Import pasted theme";
    reportOpen.value = true;
  } finally {
    reading.value = false;
  }
};

/* ------------------------------------------------------------ drops -- */

const dragging = ref(false);
let dragDepth = 0;
let lastDrop: { names: string; at: number } | null = null;

/* Tauri and HTML5 may both report one drop: the second report is ignored. */
const isRepeat = (names: string[]) => {
  const key = [...names].sort().join("|");
  const now = Date.now();
  const repeat = lastDrop !== null && lastDrop.names === key && now - lastDrop.at < 1500;
  lastDrop = { names: key, at: now };
  return repeat;
};

let unlisten: UnlistenFn | null = null;
let unmounted = false;
onMounted(async () => {
  try {
    const stop = await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") dragging.value = true;
      else if (payload.type === "leave") dragging.value = false;
      else if (payload.type === "drop") {
        dragging.value = false;
        if (!payload.paths.length || isRepeat(payload.paths.map((path) => path.split(/[\\/]/).pop()!)))
          return;
        const { sources, errors } = await readThemePaths(payload.paths);
        await showReport(sources, errors);
      }
    });
    if (unmounted) stop();
    else unlisten = stop;
  } catch {
    /* not in Tauri: HTML5 drops below */
  }
});
onBeforeUnmount(() => {
  unmounted = true;
  unlisten?.();
});

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
const onDragEnter = (event: DragEvent) => {
  if (!hasFiles(event)) return;
  dragDepth++;
  dragging.value = true;
};
const onDragLeave = (event: DragEvent) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
};
const onDragOver = (event: DragEvent) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
};
const onDrop = async (event: DragEvent) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length || isRepeat(files.map((file) => file.name))) return;
  const { sources, errors } = await readThemeBlobs(files);
  await showReport(sources, errors);
};

// The whole page is a drop target while Appearance is open.
onMounted(() => {
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
});
onBeforeUnmount(() => {
  window.removeEventListener("dragenter", onDragEnter);
  window.removeEventListener("dragleave", onDragLeave);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("drop", onDrop);
});

/* ------------------------------------------------------------ other -- */

const newTheme = () => router.push({ name: "SettingsThemeEditor", params: { id: "" } });
const openFolder = async () => {
  try {
    await theme.openFolder();
  } catch (e) {
    toast({ title: "Couldn't open the themes folder", description: errorMessage(e), variant: "destructive" });
  }
};

defineExpose({ showReport });
</script>

<template>
  <SettingsSection
    title="Add a theme"
    description="VS Code, Sublime Text, TextMate and T3 Code themes all work."
  >
    <div class="space-y-3 px-5 py-4">
      <div
        class="relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-7 text-center transition-[border-color,background-color] duration-fast"
        :class="dragging ? 'border-primary bg-primary/5' : 'border-border bg-background/40'"
        data-testid="theme-drop-zone"
      >
        <div
          class="flex h-9 w-9 items-center justify-center rounded-lg border bg-surface-2 shadow-xs transition-colors duration-fast"
          :class="dragging ? 'border-primary/40 text-link' : 'text-muted-foreground'"
        >
          <Loader2 v-if="reading" class="h-4 w-4 animate-spin" />
          <Upload v-else class="h-4 w-4" />
        </div>
        <div class="space-y-0.5">
          <p class="text-sm font-medium text-foreground">
            {{ dragging ? "Drop to import" : "Drop theme files here" }}
          </p>
          <p class="text-xs text-muted-foreground">
            <span class="font-mono">.json</span>,
            <span class="font-mono">.jsonc</span>,
            <span class="font-mono">.sublime-color-scheme</span> or
            <span class="font-mono">.tmTheme</span> · light and dark files are paired
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :disabled="reading" @click="importFiles">
          <FileUp class="h-3.5 w-3.5" />
          Import file…
        </Button>
        <Button variant="outline" size="sm" @click="pasteOpen = true">
          <ClipboardPaste class="h-3.5 w-3.5" />
          Paste JSON
        </Button>
        <Button variant="outline" size="sm" @click="newTheme">
          <Plus class="h-3.5 w-3.5" />
          New theme
        </Button>
        <Button variant="ghost" size="sm" class="ml-auto text-muted-foreground" @click="openFolder">
          <FolderOpen class="h-3.5 w-3.5" />
          Open themes folder
        </Button>
      </div>
    </div>

    <Dialog v-model:open="pasteOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>Paste a theme</DialogTitle>
          <DialogDescription>
            A VS Code colour theme, a Sublime colour scheme, a TextMate theme or a
            T3 Code / JET Pilot theme file.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          v-model="pasted"
          class="h-64 resize-none font-mono text-xs"
          placeholder='{ "name": "My theme", "type": "dark", "colors": { … } }'
          aria-label="Theme JSON"
          spellcheck="false"
          :aria-invalid="pasteError ? 'true' : undefined"
        />
        <p v-if="pasteError" class="-mt-2 text-xs text-destructive" role="alert">{{ pasteError }}</p>
        <DialogFooter>
          <Button variant="ghost" @click="pasteOpen = false">Cancel</Button>
          <Button :disabled="!pasted.trim() || reading" @click="importPasted">
            <Loader2 v-if="reading" class="h-4 w-4 animate-spin" />
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ThemeInstallDialog
      v-model:open="reportOpen"
      :title="reportTitle"
      :report="report"
      :busy="installing"
      @install="install"
    />
  </SettingsSection>
</template>
