<script setup lang="ts">
/*
 * Settings › Appearance › Themes: every theme as a card, in three groups.
 *
 * - Clicking a card applies it like the command palette does: a theme with
 *   both appearances is used for both, a single-appearance theme claims its
 *   own half (Dracula becomes the dark theme). The card menu sets halves
 *   explicitly.
 * - Hovering a card for 250 ms previews it on the whole app; leaving the
 *   cards restores the saved theme. Moving between cards keeps previewing.
 * - Previews resolve one card per frame (createTaskQueue), skeletons first.
 */
import { useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import ThemeCard from "./ThemeCard.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import { useTheme } from "@/providers/ThemeProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { clickMode, duplicateTheme, groupThemes, shownAppearance } from "@/lib/themes/library";

import type { ThemeAppearance, ThemeEntry, ThemeToken } from "@/lib/themes/types";
import {
  createTaskQueue,
  errorMessage,
  exportThemeFile,
  useWantedAppearance,
} from "./shared";

const theme = useTheme();
const { settings } = injectStrict(SettingsContextStateKey);
const wanted = useWantedAppearance();
const router = useRouter();
const { toast } = useToast();

const groups = computed(() => groupThemes(theme.themes.value));
const loading = computed(() => theme.themes.value.length === 0);
const halves = computed(() => ({
  lightTheme: settings.value.appearance.lightTheme,
  darkTheme: settings.value.appearance.darkTheme,
}));

/* ------------------------------------------------------- previews -- */

interface Preview {
  entry: ThemeEntry;
  appearance: ThemeAppearance;
  vars: Record<ThemeToken, string>;
}
const previews = shallowReactive(new Map<string, Preview>());
const queue = createTaskQueue();
const pending = new Map<string, { entry: ThemeEntry; appearance: ThemeAppearance }>();

const cardAppearance = (entry: ThemeEntry) => shownAppearance(entry.appearances, wanted.value);

const refreshPreviews = () => {
  const ids = new Set<string>();
  for (const entry of theme.themes.value) {
    if (entry.error) continue;
    ids.add(entry.id);
    const appearance = cardAppearance(entry);
    const current = previews.get(entry.id);
    const queued = pending.get(entry.id);
    if (current?.entry === entry && current.appearance === appearance) continue;
    if (queued?.entry === entry && queued.appearance === appearance) continue;
    const job = { entry, appearance };
    pending.set(entry.id, job);
    // The old preview stays until the new one is ready (no flash).
    void queue(() => (pending.get(entry.id) === job ? theme.resolve(entry.id, appearance) : null))
      .then((resolved) => {
        if (!resolved || pending.get(entry.id) !== job) return;
        pending.delete(entry.id);
        previews.set(entry.id, { entry, appearance, vars: resolved.vars });
      })
      .catch(() => pending.get(entry.id) === job && pending.delete(entry.id));
  }
  for (const id of previews.keys()) if (!ids.has(id)) previews.delete(id);
};
watch([theme.themes, wanted], refreshPreviews, { immediate: true });

// The list comes with the lazy theme runtime: load it now.
onMounted(() => void theme.resolved().catch(() => undefined));

/* ---------------------------------------------------- live preview -- */

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let restoreTimer: ReturnType<typeof setTimeout> | undefined;
let previewing: string | null = null;

const endPreview = () => {
  clearTimeout(hoverTimer);
  clearTimeout(restoreTimer);
  if (previewing === null) return;
  previewing = null;
  void theme.preview(null);
};

const onHover = (entry: ThemeEntry, hovering: boolean) => {
  if (entry.error) return;
  clearTimeout(hoverTimer);
  if (hovering) {
    clearTimeout(restoreTimer);
    // Already previewing: follow the pointer a little faster.
    hoverTimer = setTimeout(
      () => {
        previewing = entry.id;
        void theme.preview(entry.id, wanted.value);
      },
      previewing ? 120 : 250
    );
  } else if (previewing !== null) {
    restoreTimer = setTimeout(endPreview, 150);
  }
};
onBeforeUnmount(endPreview);

/* --------------------------------------------------------- actions -- */

const use = (entry: ThemeEntry, mode: ThemeAppearance | "both") => {
  clearTimeout(hoverTimer);
  clearTimeout(restoreTimer);
  previewing = null;
  theme.setTheme(entry.id, mode);
  if (mode !== "both" && mode !== wanted.value) {
    toast({
      title: `${entry.name} is your ${mode} theme`,
      description: `It shows when the appearance is ${mode}.`,
    });
  }
};

const apply = (entry: ThemeEntry) => use(entry, clickMode(entry));

const openEditor = (id?: string) =>
  router.push({ name: "SettingsThemeEditor", params: { id: id ?? "" } });

const duplicate = async (entry: ThemeEntry) => {
  try {
    const file = await theme.loadFile(entry.id);
    const [copy] = await theme.install([duplicateTheme(file, entry.id)], "user");
    if (copy) await openEditor(copy.id);
  } catch (e) {
    toast({ title: `Couldn't duplicate ${entry.name}`, description: errorMessage(e), variant: "destructive" });
  }
};

const exportTheme = async (entry: ThemeEntry, forT3: boolean) => {
  try {
    const file = await theme.loadFile(entry.id);
    const path = await exportThemeFile(file, entry, forT3);
    if (path) toast({ title: `Exported ${entry.name}`, description: path, variant: "success" });
  } catch (e) {
    toast({ title: `Couldn't export ${entry.name}`, description: errorMessage(e), variant: "destructive" });
  }
};

/* The dialog closes (update:open) before its action's click handler runs. */
const deleting = ref<ThemeEntry | null>(null);
const deleteOpen = ref(false);
const askDelete = (entry: ThemeEntry) => {
  deleting.value = entry;
  deleteOpen.value = true;
};
const confirmDelete = async () => {
  const entry = deleting.value;
  deleteOpen.value = false;
  if (!entry) return;
  try {
    await theme.remove(entry.id);
    toast({ title: `Deleted ${entry.name}` });
  } catch (e) {
    toast({ title: `Couldn't delete ${entry.name}`, description: errorMessage(e), variant: "destructive" });
  }
};

defineExpose({ openEditor });
</script>

<template>
  <SettingsSection
    title="Themes"
    description="Click a theme to use it. Hover to preview it on the whole app."
  >
    <template #actions>
      <Button variant="outline" size="sm" @click="openEditor()">
        <Plus class="h-3.5 w-3.5" />
        New theme
      </Button>
    </template>

    <div v-if="loading" class="space-y-3 px-5 py-4" aria-busy="true">
      <Skeleton class="h-3 w-20" />
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div v-for="index in 6" :key="index" class="rounded-lg border bg-card p-1.5">
          <Skeleton class="h-28 rounded-md" />
          <Skeleton class="mx-1 mt-3 h-3 w-2/3" />
          <Skeleton class="mx-1 mb-1 mt-2.5 h-4 w-20" />
        </div>
      </div>
    </div>

    <template v-else>
      <div
        v-for="group in groups"
        :key="group.id"
        class="space-y-3 px-5 py-4"
        role="group"
        :aria-label="`${group.label} themes`"
      >
        <h3 class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {{ group.label }}
          <span class="tabular-nums text-muted-foreground/70">{{ group.entries.length }}</span>
        </h3>
        <div v-if="group.entries.length" class="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <ThemeCard
            v-for="entry in group.entries"
            :key="entry.id"
            :entry="entry"
            :vars="previews.get(entry.id)?.vars ?? null"
            :appearance="previews.get(entry.id)?.appearance ?? cardAppearance(entry)"
            :settings="halves"
            @apply="apply(entry)"
            @use="use(entry, $event)"
            @hover="onHover(entry, $event)"
            @duplicate="duplicate(entry)"
            @edit="openEditor(entry.id)"
            @export="exportTheme(entry, $event)"
            @delete="askDelete(entry)"
          />
        </div>
        <div
          v-else
          class="flex flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-6 text-center"
        >
          <p class="text-sm font-medium text-foreground">No themes of your own yet</p>
          <p class="max-w-sm text-xs text-muted-foreground">
            Import a VS Code, Sublime Text, TextMate or T3 Code theme below, install one
            from Open VSX, or start from scratch.
          </p>
          <Button variant="link" size="sm" class="mt-1 h-6 px-0" @click="openEditor()">
            Create a theme
          </Button>
        </div>
      </div>
    </template>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {{ deleting?.name }}?</AlertDialogTitle>
          <AlertDialogDescription>
            The theme file is removed from your themes folder. Light or dark mode
            using it switches back to JET.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmDelete"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsSection>
</template>
