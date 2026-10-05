<script setup lang="ts">
/*
 * What an import found, before anything is written: the themes (with
 * swatches, appearances and a checkbox each, all checked), the importers'
 * warnings and the files that failed. Used by file / paste / drop imports
 * and by the Open VSX gallery.
 */
import { AlertTriangle, ChevronRight, FileWarning, Loader2 } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import ThemeSwatches from "./ThemeSwatches.vue";
import { appearancesOf } from "@/lib/themes/library";
import type { ThemeFile } from "@/lib/themes/types";
import type { ImportReport } from "./shared";

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  report: ImportReport | null;
  busy?: boolean;
  /** Shown under the list (e.g. the Open VSX licence). */
  note?: string;
}>();

const emit = defineEmits<{
  (e: "update:open", open: boolean): void;
  (e: "install", files: ThemeFile[]): void;
}>();

const selected = ref(new Set<string>());
watch(
  () => props.report,
  (report) => (selected.value = new Set(report?.themes.map((theme) => theme.key) ?? [])),
  { immediate: true }
);
const toggle = (key: string, checked: boolean) => {
  const next = new Set(selected.value);
  if (checked) next.add(key);
  else next.delete(key);
  selected.value = next;
};

const themes = computed(() => props.report?.themes ?? []);
const count = computed(() => themes.value.filter((theme) => selected.value.has(theme.key)).length);
const showWarnings = ref(false);

const appearanceLabel = (file: ThemeFile) => {
  const appearances = appearancesOf(file);
  return appearances.length === 2 ? "Light + dark" : appearances[0] === "light" ? "Light" : "Dark";
};

const install = () =>
  emit(
    "install",
    themes.value.filter((theme) => selected.value.has(theme.key)).map((theme) => theme.file)
  );
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => !busy && emit('update:open', value)">
    <DialogContent class="max-w-xl gap-0 p-0" data-testid="theme-install-dialog">
      <DialogHeader class="px-5 pb-3 pt-5">
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description || themes.length">
          {{
            description ??
            (themes.length === 1 ? "1 theme found." : `${themes.length} themes found.`)
          }}
        </DialogDescription>
      </DialogHeader>

      <div class="max-h-[55vh] space-y-3 overflow-y-auto px-5 pb-4">
        <ul v-if="themes.length" class="divide-y divide-border-subtle overflow-hidden rounded-lg border bg-card">
          <li v-for="theme in themes" :key="theme.key">
            <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent/50">
              <Checkbox
                :checked="selected.has(theme.key)"
                :disabled="busy"
                @update:checked="(checked: boolean) => toggle(theme.key, checked)"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-foreground">{{ theme.file.name }}</p>
                <p class="truncate text-xs text-muted-foreground">
                  {{ appearanceLabel(theme.file) }} · {{ theme.source }}
                </p>
              </div>
              <ThemeSwatches :file="theme.file" />
            </label>
          </li>
        </ul>

        <div
          v-if="report?.errors.length"
          class="space-y-1.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-3"
          role="alert"
        >
          <p class="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <FileWarning class="h-4 w-4" />
            {{
              report.errors.length === 1
                ? "1 file could not be imported"
                : `${report.errors.length} files could not be imported`
            }}
          </p>
          <ul class="space-y-1 pl-5">
            <li v-for="error in report.errors" :key="error.source" class="text-xs text-foreground">
              <span class="font-mono">{{ error.source }}</span>
              <span class="text-muted-foreground"> — {{ error.message }}</span>
            </li>
          </ul>
        </div>

        <div v-if="report?.warnings.length" class="rounded-lg border">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground focus-ring"
            :aria-expanded="showWarnings"
            @click="showWarnings = !showWarnings"
          >
            <AlertTriangle class="h-3.5 w-3.5 text-warning" />
            {{ report.warnings.length === 1 ? "1 note" : `${report.warnings.length} notes` }} from the importer
            <ChevronRight
              class="ml-auto h-3.5 w-3.5 transition-transform duration-fast"
              :class="showWarnings ? 'rotate-90' : ''"
            />
          </button>
          <ul v-if="showWarnings" class="space-y-1 border-t border-border-subtle px-3 py-2">
            <li v-for="(warning, index) in report.warnings" :key="index" class="text-xs text-muted-foreground">
              {{ warning }}
            </li>
          </ul>
        </div>

        <p v-if="note" class="text-xs text-muted-foreground">{{ note }}</p>
      </div>

      <DialogFooter class="border-t px-5 py-3">
        <Button variant="ghost" :disabled="busy" @click="emit('update:open', false)">
          {{ themes.length ? "Cancel" : "Close" }}
        </Button>
        <Button v-if="themes.length" :disabled="busy || count === 0" @click="install">
          <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />
          {{ count === 1 ? "Install theme" : `Install ${count} themes` }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
