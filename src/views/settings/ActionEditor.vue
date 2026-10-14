<script setup lang="ts">
/*
 * Settings › Actions › New action / Edit: a friendly form for one action
 * file. What it applies to, what it does (with the variables one click
 * away), what it asks first, and a live preview against a sample object.
 * Saving writes YAML (only the changed keys of an existing file, so its
 * comments stay); "Edit as YAML" opens the same file in the editor.
 */
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { type as osType } from "@tauri-apps/plugin-os";
import { useEventListener } from "@vueuse/core";
import { ArrowLeft, ChevronRight, Code, Plus, Trash2, X } from "lucide-vue-next";
import PageHeader from "@/components/page/PageHeader.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import IconPicker from "@/components/customActions/IconPicker.vue";
import TemplateField, { type TemplateVariable } from "@/components/customActions/TemplateField.vue";
import ActionPreview from "@/components/customActions/ActionPreview.vue";
import { useCustomActions } from "@/lib/customActions/store";
import { fileNameFor, parseActionFile } from "@/lib/customActions/schema";
import { describeScope, kindWords } from "@/lib/customActions/scope";
import { actionMutates, defaultInputs, planItem } from "@/lib/customActions/plan";
import { sampleItem } from "@/lib/customActions/samples";
import { draftFromAction, draftToYaml, emptyDraft, type ActionDraft } from "@/lib/customActions/draft";
import { RUN_LABELS } from "@/lib/customActions/words";
import { RUN_TYPES, type RunType } from "@/lib/customActions/types";
import { writeActionFile } from "@/components/settings/actions/shared";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict, cn } from "@/lib/utils";

const route = useRoute();
const router = useRouter();
const { context } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const { files, ready } = useCustomActions();
const isWindows = osType() === "windows";

const fileParam = computed(() => (typeof route.params.file === "string" && route.params.file) || "");
const file = computed(() => files.value.find((f) => f.file === fileParam.value) ?? null);
const isNew = computed(() => !fileParam.value);

const draft = reactive<ActionDraft>(emptyDraft());
const loaded = ref(false);
/* The YAML the form started from: unsaved when the draft differs. */
const baseline = ref("");

watch(
  [file, ready],
  () => {
    if (loaded.value || !ready.value) return;
    if (!isNew.value) {
      if (!file.value) return;
      // A broken file can't be shown as a form: fix it in YAML.
      if (!file.value.action) {
        router.replace({ name: "SettingsActionYaml", params: { file: file.value.file } });
        return;
      }
      Object.assign(draft, draftFromAction(file.value.action));
    }
    baseline.value = draftToYaml(draft, file.value?.text);
    loaded.value = true;
  },
  { immediate: true }
);

const yamlText = computed(() => draftToYaml(draft, file.value?.text));
const dirty = computed(() => loaded.value && yamlText.value !== baseline.value);
const fileName = computed(
  () => file.value?.file ?? fileNameFor(draft.name || "action", files.value.map((f) => f.file))
);
const parsed = computed(() => parseActionFile(fileName.value, yamlText.value));

/* Problems show next to their field once the user tried to save, or once the field has text. */
const attempted = ref(false);
const errorAt = (...prefixes: string[]) => {
  const error = parsed.value.error;
  if (!error || !(attempted.value || draft.name)) return "";
  const path = error.path ?? "";
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)) ? error.message : "";
};
const runError = computed(() => errorAt("run"));
const otherError = computed(() => {
  const error = parsed.value.error;
  if (!error || !attempted.value) return "";
  const known = ["name", "icon", "shortcut", "scope", "run", "inputs", "confirm"];
  return known.some((prefix) => (error.path ?? "").startsWith(prefix)) ? "" : error.message;
});

/* ---------------------------------------------------------- applies to -- */

const COMMON_KINDS = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Service", "Job", "CronJob", "Ingress", "ConfigMap", "Node"];
const anyKind = computed({
  get: () => draft.kinds.length === 0,
  set: (on: boolean) => (draft.kinds = on ? [] : ["Pod"]),
});
const kindDraft = ref("");
const addKind = (kind: string) => {
  const value = kind.trim();
  if (value && !draft.kinds.some((k) => k.toLowerCase() === value.toLowerCase())) draft.kinds.push(value);
  kindDraft.value = "";
};
const onKindKey = (event: KeyboardEvent) => {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addKind(kindDraft.value);
  } else if (event.key === "Backspace" && !kindDraft.value && draft.kinds.length) {
    draft.kinds.pop();
  }
};
const removeKind = (kind: string) => (draft.kinds = draft.kinds.filter((k) => k !== kind));
const suggestedKinds = computed(() => COMMON_KINDS.filter((kind) => !draft.kinds.includes(kind)).slice(0, 6));

const narrowed = computed(() => !!(draft.namespaces || draft.contexts || draft.labels));
const showNarrow = ref(false);
watch(loaded, () => (showNarrow.value = narrowed.value));

const scopeWords = computed(() =>
  describeScope({
    kinds: draft.kinds,
    namespaces: draft.namespaces.split(",").map((s) => s.trim()).filter(Boolean),
    contexts: draft.contexts.split(",").map((s) => s.trim()).filter(Boolean),
    labels: draft.labels,
    multiple: draft.multiple,
  })
);

/* -------------------------------------------------------- what it does -- */

const variables = computed<TemplateVariable[]>(() => {
  const list: TemplateVariable[] = [
    { label: "name", insert: "{{name}}" },
    { label: "namespace", insert: "{{namespace}}" },
    { label: "kind", insert: "{{kind}}" },
    { label: "context", insert: "{{context}}" },
    { label: "labels.app", insert: "{{labels.app}}", title: "A label value (any key)" },
    { label: "annotations[…]", insert: "{{annotations['example.com/key']}}", title: "An annotation value (any key)" },
    { label: ".spec…", insert: "{{.spec.replicas}}", title: "Any field of the object, as a path" },
  ];
  if (draft.type === "exec" || draft.kinds.length === 0 || draft.kinds.some((k) => k === "Pod" || ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet"].includes(k))) {
    list.push({ label: "container", insert: "{{container}}" }, { label: "image", insert: "{{image}}" });
  }
  if (draft.type === "command") list.push({ label: "kubeconfig", insert: "{{kubeconfig}}" });
  for (const input of draft.inputs) {
    if (input.name.trim()) list.push({ label: `input.${input.name.trim()}`, insert: `{{input.${input.name.trim()}}}` });
  }
  return list;
});

const PLACEHOLDERS: Record<Exclude<RunType, "exec">, string> = {
  open: "https://grafana.example.com/d/abc?var-pod={{name}}",
  command: "stern {{name}} --context {{context}} --namespace {{namespace}}",
  kubectl: "logs -f {{name}} --tail 100",
  patch: "spec:\n  replicas: 3",
  copy: "{{.spec.containers[0].image}}",
};

const FIELD_HINTS: Record<RunType, string> = {
  open: "Opens in your browser. Values are URL-encoded.",
  command: isWindows
    ? "Runs in PowerShell. Values are passed as data, never as code."
    : "Runs in sh. Values are passed as data, never as code. KUBECONFIG points to the object's kubeconfig.",
  kubectl: "--context, --kubeconfig and --namespace are added for the object.",
  exec: "Runs in the object's container. Leave empty for a shell.",
  patch: "A JSON merge patch, in YAML. Always changes the cluster.",
  copy: "Copied to the clipboard.",
};

/* Live preview: the first kind of the scope, on the current context. */
const sampleKind = ref("");
watch(
  () => draft.kinds.join(),
  () => {
    if (!draft.kinds.includes(sampleKind.value)) sampleKind.value = draft.kinds[0] ?? (draft.type === "exec" ? "Pod" : "Deployment");
  },
  { immediate: true }
);
const sample = computed(() => sampleItem(sampleKind.value || "Pod", context.value || "my-cluster"));
/* The preview works before the action has a name. */
const previewParsed = computed(() =>
  draft.name.trim() ? parsed.value : parseActionFile(fileName.value, draftToYaml({ ...draft, name: "Untitled" }))
);
const preview = computed(() => {
  const action = previewParsed.value.action;
  if (!action) return null;
  return planItem(action, sample.value, {
    inputs: defaultInputs(action),
    dialect: isWindows ? "powershell" : "posix",
    containerShell: settings.value.terminal.containerShell || "/bin/sh",
  });
});
const previewProblem = computed(() => (preview.value ? null : previewParsed.value.error?.message ?? null));
const detectedMutation = computed(() => {
  const action = previewParsed.value.action;
  return !!action && !draft.mutates && draft.type !== "patch" && !!preview.value && actionMutates(action, [preview.value]);
});

/* -------------------------------------------------------- before it runs -- */

const addInput = () => {
  let n = draft.inputs.length + 1;
  while (draft.inputs.some((input) => input.name === `value${n}`)) n++;
  draft.inputs.push({ name: draft.inputs.length ? `value${n}` : "value", label: "", default: "", options: "", type: "text" });
};
const removeInput = (index: number) => draft.inputs.splice(index, 1);

const confirmOn = computed({
  get: () => draft.confirm !== "",
  set: (on: boolean) => (draft.confirm = on ? `Run ${draft.name || "this action"} on {{name}}?` : ""),
});

/* --------------------------------------------------------------- save -- */

const saving = ref(false);
const goBack = () => router.push({ name: "SettingsCategory", params: { category: "actions" } });

const write = async (): Promise<boolean> => {
  saving.value = true;
  const ok = await writeActionFile(fileName.value, yamlText.value);
  saving.value = false;
  if (ok) baseline.value = yamlText.value;
  return ok;
};

const save = async () => {
  attempted.value = true;
  if (parsed.value.error) {
    toast({ title: "Not saved yet", description: parsed.value.error.message, variant: "warning" });
    return;
  }
  if (!(await write())) return;
  toast({ title: `Saved ${draft.name}`, description: fileName.value, variant: "success", autoDismiss: true });
  goBack();
};

const editYaml = async () => {
  const target = fileName.value;
  if ((isNew.value || dirty.value) && !(await write())) return;
  router.push({ name: "SettingsActionYaml", params: { file: target } });
};

/* Mod+S saves, like the YAML editor. */
const isMac = osType() === "macos";
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if ((isMac ? event.metaKey : event.ctrlKey) && !event.altKey && event.code === "KeyS") {
    event.preventDefault();
    void save();
  }
});

onBeforeRouteLeave((to) => {
  if (!dirty.value || to.name === "SettingsActionYaml") return true;
  return window.confirm("Discard your changes to this action?");
});

const sectionHeading = "text-sm font-medium text-foreground";
const sectionHint = "text-xs text-muted-foreground";
const fieldLabel = "text-xs font-medium text-muted-foreground";
</script>

<template>
  <div v-if="loaded" class="space-y-10">
    <div class="space-y-4">
      <Button variant="ghost" size="sm" class="-ml-2.5 text-muted-foreground" @click="goBack">
        <ArrowLeft class="h-3.5 w-3.5" />
        Actions
      </Button>
      <PageHeader :title="isNew ? 'New action' : draft.name || file?.file || 'Action'">
        <template #description>
          {{ isNew ? "Saved as" : "In" }}
          <span class="font-mono text-xs">{{ fileName }}</span>
          in the actions folder
        </template>
        <template #actions>
          <Button variant="ghost" size="sm" class="text-muted-foreground" @click="editYaml">
            <Code class="h-3.5 w-3.5" />
            Edit as YAML
          </Button>
          <Button size="sm" :disabled="saving || (!isNew && !dirty)" @click="save">Save</Button>
        </template>
      </PageHeader>
    </div>

    <!-- Identity -->
    <section class="space-y-4">
      <div class="flex items-end gap-3">
        <IconPicker v-model="draft.icon" />
        <div class="min-w-0 flex-1 space-y-1.5">
          <Label for="action-name" :class="fieldLabel">Name</Label>
          <Input
            id="action-name"
            v-model="draft.name"
            placeholder="Open in Grafana"
            maxlength="60"
            autocomplete="off"
            :aria-invalid="!!errorAt('name') || undefined"
          />
        </div>
        <div class="w-44 shrink-0 space-y-1.5">
          <Label for="action-shortcut" :class="fieldLabel">
            Shortcut <span class="font-normal text-muted-foreground/70">optional</span>
          </Label>
          <Input
            id="action-shortcut"
            v-model="draft.shortcut"
            placeholder="Mod+Shift+L"
            title="Mod is ⌘ on macOS and Ctrl elsewhere"
            class="font-mono text-xs"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="!!errorAt('shortcut') || undefined"
          />
        </div>
      </div>
      <p v-if="errorAt('name', 'icon', 'shortcut')" class="text-xs text-destructive">
        {{ errorAt("name", "icon", "shortcut") }}
      </p>
      <div class="space-y-1.5">
        <Label for="action-description" :class="fieldLabel">Description</Label>
        <Input
          id="action-description"
          v-model="draft.description"
          placeholder="Optional: one line about what it does"
          autocomplete="off"
        />
      </div>
    </section>

    <!-- Applies to -->
    <section class="space-y-4">
      <header class="space-y-0.5 border-b pb-2.5">
        <h2 :class="sectionHeading">Applies to</h2>
        <p :class="sectionHint">{{ scopeWords }}</p>
      </header>

      <div class="flex items-center justify-between gap-6">
        <div class="space-y-0.5">
          <p class="text-sm text-foreground">Any kind</p>
          <p :class="sectionHint">Or pick the kinds it is for.</p>
        </div>
        <Switch v-model:checked="anyKind" aria-label="Any kind" />
      </div>

      <div v-if="!anyKind" class="space-y-2">
        <div
          class="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-1.5 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
        >
          <span
            v-for="kind in draft.kinds"
            :key="kind"
            class="inline-flex h-6 items-center gap-1 rounded bg-muted pl-2 pr-1 text-xs text-foreground"
          >
            {{ kind }}
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              :aria-label="`Remove ${kind}`"
              @click="removeKind(kind)"
            >
              <X class="h-3 w-3" />
            </button>
          </span>
          <input
            v-model="kindDraft"
            class="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/80"
            placeholder="Add a kind, e.g. Rollout"
            aria-label="Add a kind"
            spellcheck="false"
            @keydown="onKindKey"
            @blur="addKind(kindDraft)"
          />
        </div>
        <div v-if="suggestedKinds.length" class="flex flex-wrap items-center gap-1">
          <button
            v-for="kind in suggestedKinds"
            :key="kind"
            type="button"
            class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring"
            @click="addKind(kind)"
          >
            <Plus class="h-3 w-3" />{{ kind }}
          </button>
        </div>
      </div>

      <div class="flex items-center justify-between gap-6">
        <div class="space-y-0.5">
          <p class="text-sm text-foreground">Several at once</p>
          <p :class="sectionHint">Also offered for selected rows; runs once per object.</p>
        </div>
        <Switch v-model:checked="draft.multiple" aria-label="Several at once" />
      </div>

      <div>
        <button
          type="button"
          class="-ml-1 flex items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
          :aria-expanded="showNarrow"
          @click="showNarrow = !showNarrow"
        >
          <ChevronRight class="h-3.5 w-3.5 transition-transform duration-fast" :class="showNarrow && 'rotate-90'" />
          Only some namespaces, clusters or labels
        </button>
        <div v-if="showNarrow" class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="space-y-1.5">
            <Label for="action-namespaces" :class="fieldLabel">Namespaces</Label>
            <Input id="action-namespaces" v-model="draft.namespaces" placeholder="prod-*, !kube-system" class="font-mono text-xs" spellcheck="false" />
          </div>
          <div class="space-y-1.5">
            <Label for="action-contexts" :class="fieldLabel">Contexts</Label>
            <Input id="action-contexts" v-model="draft.contexts" placeholder="prod-*" class="font-mono text-xs" spellcheck="false" />
          </div>
          <div class="space-y-1.5">
            <Label for="action-labels" :class="fieldLabel">Labels</Label>
            <Input
              id="action-labels"
              v-model="draft.labels"
              placeholder="app=web, tier in (api)"
              class="font-mono text-xs"
              spellcheck="false"
              :aria-invalid="!!errorAt('scope') || undefined"
            />
          </div>
        </div>
        <p v-if="errorAt('scope')" class="mt-2 text-xs text-destructive">{{ errorAt("scope") }}</p>
      </div>
    </section>

    <!-- What it does -->
    <section class="space-y-4">
      <header class="space-y-0.5 border-b pb-2.5">
        <h2 :class="sectionHeading">What it does</h2>
        <p :class="sectionHint">{{ FIELD_HINTS[draft.type] }}</p>
      </header>

      <Tabs v-model="draft.type">
        <TabsList aria-label="What it does">
          <TabsTrigger v-for="type in RUN_TYPES" :key="type" :value="type" class="px-3">
            {{ RUN_LABELS[type] }}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <template v-if="draft.type === 'exec'">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <div class="space-y-1.5">
            <Label for="action-exec" :class="fieldLabel">Command</Label>
            <TemplateField
              id="action-exec"
              v-model="draft.execCommand"
              placeholder="Empty: a shell. Or e.g. psql -U postgres"
              :variables="variables"
              :invalid="!!runError"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="action-container" :class="fieldLabel">Container</Label>
            <Input
              id="action-container"
              v-model="draft.execContainer"
              placeholder="Asked when several"
              class="font-mono text-xs"
              spellcheck="false"
            />
          </div>
        </div>
      </template>
      <TemplateField
        v-else
        v-model="draft.templates[draft.type]"
        :rows="draft.type === 'patch' ? 5 : draft.type === 'command' ? 3 : draft.type === 'open' || draft.type === 'copy' ? 2 : 1"
        :prefix="draft.type === 'kubectl' ? 'kubectl' : undefined"
        :placeholder="PLACEHOLDERS[draft.type]"
        :variables="variables"
        :invalid="!!runError"
        aria-label="Template"
      />
      <p v-if="runError" class="text-xs text-destructive">{{ runError }}</p>

      <div v-if="draft.type === 'command' || draft.type === 'kubectl'" class="flex items-center justify-between gap-6">
        <div class="space-y-0.5">
          <p class="text-sm text-foreground">Run in</p>
          <p :class="sectionHint">
            {{ draft.background ? "No tab: the result shows in a notification." : "A terminal tab you can watch and type into." }}
          </p>
        </div>
        <Tabs :model-value="draft.background ? 'background' : 'terminal'" @update:model-value="(v) => (draft.background = v === 'background')">
          <TabsList aria-label="Run in">
            <TabsTrigger value="terminal" class="px-2.5">Terminal</TabsTrigger>
            <TabsTrigger value="background" class="px-2.5">Background</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div class="space-y-2 rounded-lg border border-border-subtle bg-card p-3">
        <ActionPreview :type="draft.type" :text="preview?.display ?? ''" :problem="previewProblem" />
        <p class="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          With a sample
          <template v-if="draft.kinds.length > 1">
            <button
              v-for="kind in draft.kinds"
              :key="kind"
              type="button"
              :class="cn('rounded px-1.5 py-0.5 transition-colors duration-fast hover:text-foreground focus-ring', kind === sampleKind && 'bg-muted text-foreground')"
              @click="sampleKind = kind"
            >
              {{ kindWords(kind, 1) }}
            </button>
          </template>
          <template v-else>{{ kindWords(sampleKind || "Pod", 1) }}</template>
          on {{ context || "your cluster" }}
        </p>
      </div>
    </section>

    <!-- Before it runs -->
    <section class="space-y-4">
      <header class="space-y-0.5 border-b pb-2.5">
        <h2 :class="sectionHeading">Before it runs</h2>
        <p :class="sectionHint">Ask for values, ask to confirm, and how careful to be.</p>
      </header>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-6">
          <div class="space-y-0.5">
            <p class="text-sm text-foreground">Ask for values</p>
            <p :class="sectionHint">A small form appears first. Use them as input.&lt;name&gt;.</p>
          </div>
          <Button variant="outline" size="sm" @click="addInput">
            <Plus class="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        <div v-if="draft.inputs.length" class="space-y-2 pt-1">
          <div class="grid grid-cols-[7rem_minmax(0,1fr)_7rem_minmax(0,1fr)_2rem] gap-2 px-0.5 text-xs text-muted-foreground">
            <span>Name</span><span>Label</span><span>Default</span><span>Choices</span><span />
          </div>
          <div
            v-for="(input, index) in draft.inputs"
            :key="index"
            class="grid grid-cols-[7rem_minmax(0,1fr)_7rem_minmax(0,1fr)_2rem] items-center gap-2"
          >
            <Input v-model="input.name" class="h-8 font-mono text-xs" aria-label="Input name" spellcheck="false" />
            <Input v-model="input.label" class="h-8" :placeholder="input.name" aria-label="Input label" />
            <Input v-model="input.default" class="h-8 text-xs" placeholder="—" aria-label="Default value" />
            <Input v-model="input.options" class="h-8 text-xs" placeholder="Free text" aria-label="Choices, comma-separated" />
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-destructive"
              :aria-label="`Remove ${input.name}`"
              @click="removeInput(index)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </div>
          <p v-if="errorAt('inputs')" class="text-xs text-destructive">{{ errorAt("inputs") }}</p>
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-6">
          <div class="space-y-0.5">
            <p class="text-sm text-foreground">Ask to confirm</p>
            <p :class="sectionHint">A question before it runs; variables work here too.</p>
          </div>
          <Switch v-model:checked="confirmOn" aria-label="Ask to confirm" />
        </div>
        <Input v-if="confirmOn" v-model="draft.confirm" aria-label="Confirmation question" :aria-invalid="!!errorAt('confirm') || undefined" />
        <p v-if="errorAt('confirm')" class="text-xs text-destructive">{{ errorAt("confirm") }}</p>
      </div>

      <div class="flex items-center justify-between gap-6">
        <div class="space-y-0.5">
          <p class="text-sm text-foreground">Changes the cluster</p>
          <p :class="sectionHint">
            <template v-if="draft.type === 'patch'">Patches always do. </template>
            <template v-else-if="detectedMutation">This kubectl command does, so it is treated that way. </template>
            Read-only clusters block it; protected ones ask to type the name first.
          </p>
        </div>
        <Switch
          :checked="draft.mutates || draft.type === 'patch' || detectedMutation"
          :disabled="draft.type === 'patch' || detectedMutation"
          aria-label="Changes the cluster"
          @update:checked="(on: boolean) => (draft.mutates = on)"
        />
      </div>

      <p v-if="otherError" class="text-xs text-destructive">{{ otherError }}</p>
    </section>
  </div>
</template>
