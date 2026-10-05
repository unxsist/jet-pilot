<script setup lang="ts">
/*
 * Settings › Appearance › the add-a-theme tile that ends your themes: drop
 * files, pick files or paste JSON. Every path runs through the importer and
 * shows what it found (ThemeInstallDialog) before installing.
 *
 * Dropping files: Tauri handles OS file drops itself (dragDropEnabled is on
 * by default), so the webview gets paths through onDragDropEvent; the fs
 * plugin adds dropped paths to the fs scope, so readTextFile works on them.
 * Plain HTML5 drops (the browser harness) read the File objects instead.
 * Either way the whole page accepts the drop while it is open.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ClipboardPaste, FileUp, Loader2, Upload } from "lucide-vue-next";
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

const formats = `${THEME_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(", ")} · light and dark files are paired`;

defineExpose({ showReport });
</script>

<template>
  <div
    class="flex min-h-[11.5rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-5 text-center transition-[border-color,background-color] duration-fast"
    :class="dragging ? 'border-primary bg-primary/5' : 'hover:border-border-strong'"
    data-testid="theme-drop-zone"
  >
    <span
      class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-fast"
      :class="dragging ? 'text-link' : 'text-muted-foreground'"
    >
      <Loader2 v-if="reading" class="h-4 w-4 animate-spin" />
      <Upload v-else class="h-4 w-4" />
    </span>
    <div class="space-y-0.5">
      <p class="text-sm font-medium text-foreground">{{ dragging ? "Drop to import" : "Add a theme" }}</p>
      <p class="text-xs text-muted-foreground" :title="formats">
        or drop theme files here
      </p>
    </div>
    <div class="flex items-center gap-1.5">
      <Button variant="outline" size="xs" :disabled="reading" @click="importFiles">
        <FileUp class="h-3 w-3" />
        Import…
      </Button>
      <Button variant="ghost" size="xs" class="text-muted-foreground hover:text-foreground" @click="pasteOpen = true">
        <ClipboardPaste class="h-3 w-3" />
        Paste
      </Button>
    </div>

    <Dialog v-model:open="pasteOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>Paste a theme</DialogTitle>
          <DialogDescription>
            A VS Code colour theme, a Sublime colour scheme, a TextMate theme or a
            JET Pilot theme file.
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
  </div>
</template>
