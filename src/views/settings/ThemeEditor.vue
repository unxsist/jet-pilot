<script setup lang="ts">
/*
 * The JSON theme editor (Settings › Appearance › a theme › Edit, or New
 * theme): Monaco with the theme JSON schema (role completion, hovers,
 * colour swatches), live preview of the draft on the whole app, validation
 * with line numbers, and a role panel showing every resolved colour.
 *
 * Route /settings/appearance/theme/:id? — no id: a new, unsaved theme;
 * a user theme's id: edit it (broken files too, to fix them); a built-in's
 * id: read only, with "Duplicate & edit".
 */
import { useRoute, useRouter } from "vue-router";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { findNodeAtLocation, modify, parseTree, applyEdits } from "jsonc-parser";
import type * as Monaco from "monaco-editor";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Info,
  Loader2,
  RotateCcw,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import Loading from "@/components/Loading.vue";
import ThemeRolesPanel from "@/components/settings/themes/ThemeRolesPanel.vue";
import { errorMessage, exportThemeFile, useWantedAppearance } from "@/components/settings/themes/shared";
import {
  editorOptions,
  loadMonaco,
  prefersReducedMotion,
  useMonacoTheme,
  type MonacoRuntime,
} from "@/components/monaco";
import { useTheme } from "@/providers/ThemeProvider";
import { useEditorPreferences } from "@/components/monaco/preferences";
import { parseThemeFile } from "@/lib/themes/validate";
import { serializeTheme } from "@/lib/themes/serialize";
import { THEME_JSON_SCHEMA, THEME_SCHEMA_URI } from "@/lib/themes/schema";
import { themeAppearances } from "@/lib/themes/runtime";
import {
  duplicateTheme,
  errorLine,
  fileNameOf,
  jsonErrorLocation,
  newThemeText,
  rolePaths,
  themeBadge,
} from "@/lib/themes/library";
import { JET_COLOR_ROLES, THEME_COLOR_ROLES } from "@/lib/themes/types";
import type { ThemeAppearance, ThemeFile } from "@/lib/themes/types";

const route = useRoute();
const router = useRouter();
const theme = useTheme();
const wanted = useWantedAppearance();
const { toast } = useToast();
const applyMonaco = useMonacoTheme();
const preferences = useEditorPreferences();

/* ------------------------------------------------------------ source -- */

const currentId = ref(String(route.params.id ?? ""));
const entry = computed(() =>
  currentId.value ? theme.themes.value.find((item) => item.id === currentId.value) : undefined
);
type Kind = "new" | "user" | "builtin";
const kind = computed<Kind>(() =>
  !currentId.value ? "new" : entry.value?.source === "builtin" ? "builtin" : "user"
);
const readonly = computed(() => kind.value === "builtin");

const loadState = ref<"loading" | "ready" | "missing">("loading");
const savedText = ref("");
const text = ref("");
const dirty = computed(() => loadState.value === "ready" && !readonly.value && text.value !== savedText.value);

const loadText = async (id: string): Promise<string | null> => {
  if (!id) return newThemeText(THEME_SCHEMA_URI);
  await theme.resolved().catch(() => undefined); // the theme list comes with the runtime
  const found = theme.themes.value.find((item) => item.id === id);
  if (!found) return null;
  if (found.source === "builtin") return serializeTheme(await theme.loadFile(id));
  // User files as written (broken ones included, to fix them).
  if (found.path) {
    try {
      return await readTextFile(`themes/${fileNameOf(found.path)}`, { baseDir: BaseDirectory.AppConfig });
    } catch {
      /* fall back to the parsed file */
    }
  }
  return found.file ? serializeTheme(found.file) : null;
};

const load = async (id: string) => {
  loadState.value = "loading";
  const loaded = await loadText(id).catch(() => null);
  if (loaded === null) {
    loadState.value = "missing";
    return;
  }
  currentId.value = id;
  savedText.value = loaded;
  text.value = loaded;
  setModelText(loaded, false);
  loadState.value = "ready";
};

/* ---------------------------------------------------------- parsing -- */

interface Problem {
  message: string;
  line: number | null;
  column?: number;
  source: "json" | "schema" | "theme";
}

const draft = shallowRef<ThemeFile | null>(null);
const raw = shallowRef<unknown>(null);
const themeProblem = shallowRef<Problem | null>(null);
const markers = shallowRef<Problem[]>([]);

const parseNow = () => {
  const value = text.value;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch (e) {
    raw.value = null;
    draft.value = null;
    const location = jsonErrorLocation(value, errorMessage(e));
    themeProblem.value = {
      message: `Not valid JSON: ${errorMessage(e).replace(/^JSON\.parse: /, "")}`,
      line: location?.line ?? null,
      column: location?.column,
      source: "json",
    };
    return;
  }
  raw.value = json;
  try {
    draft.value = parseThemeFile(json);
    themeProblem.value = null;
  } catch (e) {
    draft.value = null;
    themeProblem.value = { message: errorMessage(e), line: errorLine(value, errorMessage(e)), source: "theme" };
  }
};
const parseSoon = useDebounceFn(parseNow, 200);
watch(text, () => void parseSoon());

/* Monaco's own markers duplicate the JSON syntax error; the theme check covers the rest. */
const problems = computed<Problem[]>(() => {
  // The schema's colour format is hex-only (Monaco's swatches); any CSS
  // colour the theme check accepts (rgb(), oklch()...) is no problem.
  const list = draft.value
    ? markers.value.filter((marker) => !/^Invalid color format/i.test(marker.message))
    : [...markers.value];
  const own = themeProblem.value;
  if (own && !(own.source === "json" && list.length > 0)) list.push(own);
  return list.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
});
const valid = computed(() => draft.value !== null && problems.value.length === 0);
const showProblems = ref(false);
watch(
  () => problems.value.length,
  (count) => count === 0 && (showProblems.value = false)
);

/* ------------------------------------------------------ appearances -- */

const appearances = computed<ThemeAppearance[]>(() => (draft.value ? themeAppearances(draft.value) : []));
const previewAppearance = ref<ThemeAppearance>(wanted.value);
watch(
  appearances,
  (list) => {
    if (list.length && !list.includes(previewAppearance.value)) previewAppearance.value = list[0]!;
  },
  { immediate: true }
);

const resolvedRoles = shallowRef<Record<string, string> | null>(null);
watch(
  [draft, previewAppearance],
  async ([file, appearance]) => {
    if (!file) return; // keep the last good colours while the JSON is broken
    try {
      const resolved = await theme.resolve(file, appearance);
      if (file === draft.value) resolvedRoles.value = resolved.roles;
    } catch {
      /* the problems list says why */
    }
  },
  { immediate: true }
);

const explicitRoles = computed(() => {
  const set = new Set<string>();
  const file = raw.value as Record<string, unknown> | null;
  if (!file || typeof file !== "object") return set;
  for (const role of [...THEME_COLOR_ROLES, ...JET_COLOR_ROLES]) {
    for (const path of rolePaths(file, role, previewAppearance.value)) {
      let node: unknown = file;
      for (const key of path) node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
      if (typeof node === "string") {
        set.add(role);
        break;
      }
    }
  }
  return set;
});

/* ---------------------------------------------------- live preview -- */

const livePreview = ref(true);
let previewing = false;
watch(
  [draft, previewAppearance, livePreview, () => loadState.value],
  ([file, appearance, on, state]) => {
    if (state !== "ready") return;
    if (on && file) {
      previewing = true;
      void theme.preview(file, appearance);
    } else if (!on && previewing) {
      previewing = false;
      void theme.preview(null);
    }
  }
);
onBeforeUnmount(() => {
  if (previewing) void theme.preview(null);
});

/* ------------------------------------------------------------ Monaco -- */

const editorElement = ref<HTMLElement | null>(null);
const editorReady = ref(false);
const editorError = ref("");
let rt: MonacoRuntime | null = null;
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
const disposables: Monaco.IDisposable[] = [];
let unmounted = false;

function setModelText(value: string, undoable: boolean) {
  if (!model || model.getValue() === value) return;
  if (undoable) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  } else {
    model.setValue(value);
  }
}

const initEditor = async () => {
  try {
    rt = await loadMonaco();
  } catch (e) {
    editorError.value = `Failed to load the editor: ${errorMessage(e)}`;
    return;
  }
  if (unmounted || !editorElement.value) return;
  await applyMonaco(rt);
  if (unmounted || !editorElement.value) return;
  const { monaco } = rt;
  model = monaco.editor.createModel(text.value, "json", rt.jsonModelUri(`theme-${currentId.value || "new"}`));
  rt.setJsonSchema(model, THEME_SCHEMA_URI, THEME_JSON_SCHEMA);
  editor = monaco.editor.create(editorElement.value, {
    ...editorOptions,
    ...preferences.options.value,
    ...(prefersReducedMotion() ? { smoothScrolling: false, cursorBlinking: "solid" as const } : {}),
    model,
    readOnly: readonly.value,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    colorDecorators: true,
    quickSuggestions: { strings: true, other: true, comments: false },
  });
  preferences.track(editor);
  disposables.push(
    model.onDidChangeContent(() => (text.value = model!.getValue())),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!model || !uris.some((uri) => uri.toString() === model!.uri.toString())) return;
      markers.value = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning)
        .map((marker) => ({
          message: marker.message,
          line: marker.startLineNumber,
          column: marker.startColumn,
          source: "schema" as const,
        }));
    }),
    editor.addAction({
      id: "jet.saveTheme",
      label: "Save theme",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => void save(),
    })
  );
  editorReady.value = true;
  if (!readonly.value) editor.focus();
};
watch(readonly, (value) => editor?.updateOptions({ readOnly: value }));

const reveal = (line: number | null, column = 1) => {
  if (!editor || !line) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
};

/* Jumps to a role's value, or adds it with its resolved colour. */
const pickRole = (role: string) => {
  if (!editor || !model) return;
  const current = model.getValue();
  const tree = parseTree(current);
  const paths = rolePaths(raw.value, role, previewAppearance.value);
  for (const path of paths) {
    const node = tree && findNodeAtLocation(tree, path);
    if (node) return selectNode(node.offset, node.length);
  }
  if (readonly.value || raw.value === null) return;
  const value = resolvedRoles.value?.[role] ?? "#000000";
  const edits = modify(current, paths[0]!, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  if (!edits.length) return;
  const next = applyEdits(current, edits);
  setModelText(next, true);
  const node = findNodeAtLocation(parseTree(next)!, paths[0]!);
  if (node) selectNode(node.offset, node.length);
};
const selectNode = (offset: number, length: number) => {
  if (!editor || !model) return;
  // Inside the quotes: typing replaces the colour.
  const start = model.getPositionAt(offset + 1);
  const end = model.getPositionAt(offset + length - 1);
  editor.setSelection({
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  });
  editor.revealRangeInCenter(editor.getSelection()!);
  editor.focus();
};

/* -------------------------------------------------------------- save -- */

const saving = ref(false);
const save = async () => {
  if (readonly.value || saving.value || loadState.value !== "ready") return;
  parseNow();
  const file = draft.value;
  if (!file) {
    showProblems.value = true;
    toast({ title: "Fix the problems before saving", description: themeProblem.value?.message, variant: "destructive" });
    return;
  }
  saving.value = true;
  try {
    const snapshot = text.value;
    // Without an "id" in the JSON the theme keeps its file (and id): the
    // id parseThemeFile derived from the name must not rename it.
    const explicitId = typeof raw.value === "object" && raw.value !== null && "id" in raw.value;
    const withoutId: ThemeFile = { ...file };
    delete withoutId.id;
    const saved =
      kind.value === "new"
        ? (await theme.install([file], "user"))[0]!
        : await theme.save(currentId.value, explicitId ? file : withoutId);
    savedText.value = snapshot;
    if (saved.id !== currentId.value) {
      currentId.value = saved.id;
      await router.replace({ name: "SettingsThemeEditor", params: { id: saved.id } });
    }
    toast({ title: `Saved ${saved.name}`, variant: "success" });
  } catch (e) {
    toast({ title: "Couldn't save the theme", description: errorMessage(e), variant: "destructive" });
  } finally {
    saving.value = false;
  }
};

const revert = () => setModelText(savedText.value, true);

const exportDraft = async (portable: boolean) => {
  parseNow();
  if (!draft.value) {
    showProblems.value = true;
    return;
  }
  try {
    const path = await exportThemeFile(draft.value, { id: draft.value.id ?? (currentId.value || "theme") }, portable);
    if (path) toast({ title: `Exported ${draft.value.name}`, description: path, variant: "success" });
  } catch (e) {
    toast({ title: "Couldn't export the theme", description: errorMessage(e), variant: "destructive" });
  }
};

const duplicating = ref(false);
const duplicate = async () => {
  duplicating.value = true;
  try {
    const file = await theme.loadFile(currentId.value);
    const [copy] = await theme.install([duplicateTheme(file, currentId.value)], "user");
    if (copy) await router.replace({ name: "SettingsThemeEditor", params: { id: copy.id } });
  } catch (e) {
    toast({ title: "Couldn't duplicate the theme", description: errorMessage(e), variant: "destructive" });
  } finally {
    duplicating.value = false;
  }
};

/*
 * Ctrl/Cmd+S outside the editor too, but only for this view: not when
 * another surface (e.g. a resource editor in the bottom panel, a dialog)
 * has the focus or handled the key already.
 */
const viewElement = ref<HTMLElement | null>(null);
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.defaultPrevented) return;
  const focused = document.activeElement;
  if (focused && focused !== document.body && !viewElement.value?.contains(focused)) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
});

/* ------------------------------------------------ navigation guards -- */

/* The dialog closes (update:open) before its action's click handler runs. */
const discardOpen = ref(false);
let pendingRoute: string | null = null;
let discarding = false;
const guard = (to: { fullPath: string }) => {
  if (!dirty.value || discarding) return true;
  pendingRoute = to.fullPath;
  discardOpen.value = true;
  return false;
};
// One router guard for leaving the editor and for switching themes in it.
const removeGuard = router.beforeEach((to, from) => {
  if (from.name !== "SettingsThemeEditor") return true;
  if (to.name === "SettingsThemeEditor" && String(to.params.id ?? "") === currentId.value) return true;
  return guard(to);
});
onBeforeUnmount(removeGuard);
watch(
  () => String(route.params.id ?? ""),
  (id) => id !== currentId.value && void load(id)
);
const discard = async () => {
  const target = pendingRoute;
  pendingRoute = null;
  discardOpen.value = false;
  if (!target) return;
  discarding = true;
  try {
    await router.push(target);
  } finally {
    discarding = false;
  }
};

const back = () => router.push({ name: "SettingsAppearance" });

/* ------------------------------------------------------------ setup -- */

onMounted(async () => {
  await load(currentId.value);
  parseNow();
  if (loadState.value === "ready") await initEditor();
});
onBeforeUnmount(() => {
  unmounted = true;
  for (const disposable of disposables) disposable.dispose();
  if (rt && model) rt.setJsonSchema(model, THEME_SCHEMA_URI, null);
  editor?.dispose();
  model?.dispose();
});

const title = computed(() => draft.value?.name ?? entry.value?.name ?? (kind.value === "new" ? "New theme" : "Theme"));
const badge = computed(() =>
  kind.value === "new" ? { label: "New", tone: "accent" as const } : entry.value ? themeBadge(entry.value) : null
);
</script>

<template>
  <div ref="viewElement" class="flex h-full min-h-0 flex-col bg-background">
    <!-- Toolbar -->
    <header class="flex h-11 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
      <Button variant="ghost" size="sm" class="text-muted-foreground" @click="back">
        <ArrowLeft class="h-3.5 w-3.5" />
        Appearance
      </Button>
      <span class="h-4 w-px bg-border" aria-hidden="true"></span>
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-sm font-semibold text-foreground">{{ title }}</h1>
        <Badge v-if="badge" size="sm" :variant="badge.tone">{{ badge.label }}</Badge>
        <span
          v-if="dirty"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title="Unsaved changes"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
          Unsaved
        </span>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <Tabs v-model="previewAppearance">
          <TabsList class="h-7" aria-label="Appearance to preview">
            <TabsTrigger
              v-for="appearance in (['light', 'dark'] as const)"
              :key="appearance"
              :value="appearance"
              class="h-6 px-2.5 text-xs"
              :disabled="!appearances.includes(appearance)"
              :title="appearances.includes(appearance) ? '' : `This theme has no ${appearance} appearance: add variants.${appearance}`"
            >
              {{ appearance === "light" ? "Light" : "Dark" }}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div class="flex items-center gap-1.5 pl-1">
          <Switch id="theme-live-preview" v-model:checked="livePreview" />
          <Label for="theme-live-preview" class="cursor-pointer text-xs font-normal text-muted-foreground">
            Preview on app
          </Label>
        </div>
        <button
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium focus-ring"
          :class="
            valid
              ? 'border-success/25 bg-success/10 text-success'
              : 'border-destructive/25 bg-destructive/10 text-destructive'
          "
          :aria-expanded="showProblems"
          :disabled="valid"
          data-testid="theme-validation"
          @click="showProblems = !showProblems"
        >
          <CheckCircle2 v-if="valid" class="h-3.5 w-3.5" />
          <AlertCircle v-else class="h-3.5 w-3.5" />
          {{
            valid ? "Valid" : problems.length === 1 ? "1 problem" : `${problems.length} problems`
          }}
        </button>
        <span class="h-4 w-px bg-border" aria-hidden="true"></span>
        <Button v-if="!readonly" variant="ghost" size="sm" :disabled="!dirty" @click="revert">
          <RotateCcw class="h-3.5 w-3.5" />
          Revert
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm" :disabled="!draft">
              <Download class="h-3.5 w-3.5" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuItem @select="exportDraft(false)">JET Pilot theme…</DropdownMenuItem>
            <DropdownMenuItem @select="exportDraft(true)">Standard theme…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button v-if="readonly" size="sm" :disabled="duplicating" @click="duplicate">
          <Loader2 v-if="duplicating" class="h-3.5 w-3.5 animate-spin" />
          <Copy v-else class="h-3.5 w-3.5" />
          Duplicate &amp; edit
        </Button>
        <Button v-else size="sm" :disabled="saving || (kind !== 'new' && !dirty)" @click="save">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
          Save
        </Button>
      </div>
    </header>

    <!-- Context strip -->
    <div
      v-if="loadState === 'ready' && (readonly || kind === 'new' || entry?.error)"
      class="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs"
      :class="entry?.error ? 'bg-destructive/5 text-foreground' : 'bg-surface-1 text-muted-foreground'"
    >
      <AlertCircle v-if="entry?.error" class="h-3.5 w-3.5 shrink-0 text-destructive" />
      <Info v-else class="h-3.5 w-3.5 shrink-0" />
      <span v-if="entry?.error">This file can't be used yet: {{ entry.error }}</span>
      <span v-else-if="readonly">
        Built-in themes are read only. Duplicate it to make your own copy; the preview and
        export work as is.
      </span>
      <span v-else>
        A new theme needs a <span class="font-mono text-foreground">name</span>, an
        <span class="font-mono text-foreground">appearance</span>, a
        <span class="font-mono text-foreground">canvas</span> and an
        <span class="font-mono text-foreground">accent</span>; the rest is derived. Override
        roles under <span class="font-mono text-foreground">colors</span>, add the other
        appearance under <span class="font-mono text-foreground">variants</span>. Press
        Ctrl+Space for suggestions.
      </span>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- Editor + problems -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="relative min-h-0 flex-1">
          <div v-if="loadState === 'missing'" class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p class="text-sm font-medium text-foreground">This theme doesn't exist</p>
            <p class="text-xs text-muted-foreground">It may have been deleted or renamed.</p>
            <Button variant="outline" size="sm" class="mt-1" @click="back">Back to Appearance</Button>
          </div>
          <template v-else>
            <Loading v-if="!editorReady && !editorError" label="Loading editor…" />
            <p v-if="editorError" role="alert" class="p-4 text-sm text-destructive">{{ editorError }}</p>
            <div
              ref="editorElement"
              class="absolute inset-0"
              :class="{ invisible: !editorReady }"
              data-testid="theme-json-editor"
            ></div>
          </template>
        </div>
        <div
          v-if="showProblems && problems.length"
          class="max-h-40 shrink-0 overflow-y-auto border-t bg-surface-1"
          role="region"
          aria-label="Problems"
        >
          <ul class="py-1">
            <li v-for="(problem, index) in problems" :key="index">
              <button
                type="button"
                class="flex w-full items-start gap-2 px-4 py-1 text-left text-xs hover:bg-accent focus-ring"
                @click="reveal(problem.line, problem.column)"
              >
                <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span class="min-w-0 flex-1 text-foreground">{{ problem.message }}</span>
                <span v-if="problem.line" class="shrink-0 font-mono tabular-nums text-muted-foreground">
                  Ln {{ problem.line }}{{ problem.column ? `, Col ${problem.column}` : "" }}
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <!-- Roles -->
      <aside class="hidden w-72 shrink-0 border-l bg-card md:block" aria-label="Theme roles">
        <ThemeRolesPanel
          :roles="resolvedRoles"
          :explicit="explicitRoles"
          :readonly="readonly"
          @pick="pickRole"
        />
      </aside>
    </div>

    <AlertDialog v-model:open="discardOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes to {{ title }}. Leaving the editor will discard them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction @click="discard">Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
