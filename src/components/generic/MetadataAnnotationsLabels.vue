<script setup lang="ts">
/**
 * Labels (key=value chips) or annotations (a list; long and JSON values
 * folded, pretty-printed when opened) of an object, editable in place:
 * add, change and remove entries with the API server's key rules checked
 * as you type, a preview of the change, and a guarded patch on Save.
 * Errors stay inline, in a sentence.
 */
import { KubernetesObject } from "@kubernetes/client-node";
import { ChevronRight, Plus, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import CodeValue from "@/components/generic/CodeValue.vue";
import { usePanelTarget } from "@/composables/usePanelObject";
import { kubePatch } from "@/lib/kubeApi";
import { guard, rowTargets } from "@/lib/guardrails/guard";
import { fetchRef, pathOf } from "@/lib/resources/open";
import { detectFormat, sizeWords } from "@/lib/resources/highlight";
import {
  ANNOTATIONS_LIMIT,
  annotationsSize,
  diffEntries,
  editErrorMessage,
  isEditConflict,
  rebaseEntries,
  metadataPatch,
  validateKey,
  validateLabelValue,
} from "@/lib/resources/metadataEdit";

const props = defineProps<{
  type: "annotations" | "labels";
  object: KubernetesObject;
}>();
const editing = defineModel<boolean>("editing", { default: false });

const target = usePanelTarget(() => props.object);

/*
 * The entries as saved here, while the object is still the version from
 * before the save (kinds that aren't watched only have the patch response).
 */
const saved = shallowRef<{ over: string | undefined; entries: Record<string, string> } | null>(null);
const source = computed<Record<string, string>>(() => {
  if (saved.value && saved.value.over === props.object.metadata?.resourceVersion) return saved.value.entries;
  return (props.type === "annotations" ? props.object.metadata?.annotations : props.object.metadata?.labels) ?? {};
});

/* ------------------------------------------------------------- view -- */

const PREVIEW_COUNT = 6;
const showAll = ref(false);
const entries = computed(() => Object.entries(source.value).sort(([a], [b]) => a.localeCompare(b)));
const total = computed(() => entries.value.length);
const shown = computed(() => (showAll.value ? entries.value : entries.value.slice(0, PREVIEW_COUNT)));

/* Annotations: long, multi-line or JSON values fold. */
const opened = reactive(new Set<string>());
const isLong = (key: string, value: string) =>
  value.length > 120 || value.includes("\n") || detectFormat(value, key) === "json";
const toggle = (key: string) => (opened.has(key) ? opened.delete(key) : opened.add(key));
const LONG_TITLES: Record<string, string> = {
  "kubectl.kubernetes.io/last-applied-configuration": "Last applied configuration",
};

/* ------------------------------------------------------------- edit -- */

interface Row {
  id: number;
  key: string;
  value: string;
}
let nextId = 0;
const rows = ref<Row[]>([]);
const saving = ref(false);
const error = ref<string | null>(null);
const keyInputs = ref<InstanceType<typeof Input>[]>([]);

const noun = computed(() => (props.type === "labels" ? "label" : "annotation"));

/*
 * What the edit started from: changes are relative to it, so keys someone
 * else adds meanwhile are left alone (and changed keys are tested).
 */
const base = shallowRef<Record<string, string>>({});
const toRows = (from: Record<string, string>) =>
  Object.entries(from)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ id: nextId++, key, value }));
const start = () => {
  base.value = { ...source.value };
  rows.value = toRows(source.value);
  error.value = null;
};
watch(
  editing,
  (now) => {
    if (now) start();
  },
  { immediate: true }
);

const add = async () => {
  rows.value.push({ id: nextId++, key: "", value: "" });
  await nextTick();
  keyInputs.value[keyInputs.value.length - 1]?.focus();
};
const remove = (row: Row) => (rows.value = rows.value.filter((r) => r !== row));

const problems = computed(() => {
  const seen = new Map<string, number>();
  for (const row of rows.value) seen.set(row.key.trim(), (seen.get(row.key.trim()) ?? 0) + 1);
  return new Map(
    rows.value.map((row) => {
      const key = row.key.trim();
      const problem =
        validateKey(key) ??
        ((seen.get(key) ?? 0) > 1 ? "This key is used twice" : null) ??
        (props.type === "labels" ? validateLabelValue(row.value) : null);
      return [row.id, problem];
    })
  );
});
/* A new, still empty row isn't an error yet. */
const shownProblem = (row: Row) => (row.key === "" && row.value === "" ? null : problems.value.get(row.id));

const after = computed(() =>
  Object.fromEntries(rows.value.filter((r) => !(r.key === "" && r.value === "")).map((r) => [r.key.trim(), r.value]))
);
const changes = computed(() => diffEntries(base.value, after.value));
const tooLarge = computed(() => props.type === "annotations" && annotationsSize(after.value) > ANNOTATIONS_LIMIT);
const valid = computed(
  () => rows.value.every((row) => (row.key === "" && row.value === "") || !problems.value.get(row.id)) && !tooLarge.value
);

const preview = (value: string | undefined) => {
  const text = value ?? "";
  if (text === "") return '""';
  return text.length > 48 || text.includes("\n") ? `${text.replace(/\s+/g, " ").slice(0, 40)}… (${sizeWords(text)})` : text;
};

const cancel = () => {
  editing.value = false;
  error.value = null;
};

const objectRef = () => ({
  kind: props.object.kind ?? "",
  name: props.object.metadata?.name ?? "",
  namespace: props.object.metadata?.namespace,
  apiVersion: props.object.apiVersion,
});
const entriesOf = (object: any): Record<string, string> =>
  (props.type === "labels" ? object?.metadata?.labels : object?.metadata?.annotations) ?? {};

const save = async () => {
  if (!valid.value || changes.value.length === 0 || saving.value) return;
  const patch = metadataPatch(props.type, changes.value);
  if (!patch) return;
  const kind = props.type === "labels" ? "edit-labels" : "edit-annotations";
  if (!(await guard(kind, rowTargets([props.object])))) return;
  saving.value = true;
  error.value = null;
  const over = props.object.metadata?.resourceVersion;
  try {
    const path = await pathOf(target.value, objectRef());
    if (!path) throw new Error(`JET Pilot doesn't know where ${props.object.kind} objects live in this cluster.`);
    const result = await kubePatch<any>(
      { context: target.value.context, kubeConfig: target.value.kubeConfig || undefined },
      path,
      patch.body,
      patch.type
    );
    saved.value = { over, entries: entriesOf(result) };
    editing.value = false;
  } catch (e) {
    error.value = editErrorMessage(e, `${noun.value}s`);
    // Changed meanwhile: the edit continues from the current entries, with the user's changes.
    if (isEditConflict(e)) {
      const fresh = await fetchRef(target.value, objectRef()).catch(() => null);
      const now = fresh ? entriesOf(fresh) : { ...source.value };
      if (fresh) saved.value = { over, entries: now };
      rows.value = toRows(rebaseEntries(base.value, after.value, now));
      base.value = now;
    }
  } finally {
    saving.value = false;
  }
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancel();
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey || (event.target as HTMLElement).tagName === "INPUT")) {
    event.preventDefault();
    save();
  }
};
</script>

<template>
  <!-- Editing -->
  <div v-if="editing" class="space-y-3" @keydown="onKeydown">
    <ul class="space-y-2">
      <li v-for="(row, index) in rows" :key="row.id">
        <div v-if="type === 'labels'" class="flex items-center gap-1.5">
          <Input
            ref="keyInputs"
            v-model="row.key"
            placeholder="key"
            spellcheck="false"
            autocapitalize="off"
            class="h-7 min-w-0 flex-[3] font-mono text-xs"
            :aria-label="`Key ${index + 1}`"
            :aria-invalid="!!shownProblem(row)"
          />
          <span class="text-xs text-muted-foreground">=</span>
          <Input
            v-model="row.value"
            placeholder="value"
            spellcheck="false"
            autocapitalize="off"
            class="h-7 min-w-0 flex-[2] font-mono text-xs"
            :aria-label="`Value of ${row.key || `key ${index + 1}`}`"
            :aria-invalid="!!shownProblem(row) && !validateKey(row.key.trim())"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground"
            :aria-label="`Remove ${row.key || 'this label'}`"
            title="Remove"
            @click="remove(row)"
          >
            <X class="h-3.5 w-3.5" />
          </Button>
        </div>
        <div v-else class="space-y-1">
          <div class="flex items-center gap-1.5">
            <Input
              ref="keyInputs"
              v-model="row.key"
              placeholder="key"
              spellcheck="false"
              autocapitalize="off"
              class="h-7 min-w-0 flex-1 font-mono text-xs"
              :aria-label="`Key ${index + 1}`"
              :aria-invalid="!!shownProblem(row)"
            />
            <Button
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground"
              :aria-label="`Remove ${row.key || 'this annotation'}`"
              title="Remove"
              @click="remove(row)"
            >
              <X class="h-3.5 w-3.5" />
            </Button>
          </div>
          <Textarea
            v-model="row.value"
            placeholder="value"
            spellcheck="false"
            :rows="Math.min(6, Math.max(1, row.value.split('\n').length, Math.ceil(row.value.length / 48)))"
            class="min-h-7 w-[calc(100%-1.875rem)] resize-y py-1 font-mono text-xs leading-5"
            :aria-label="`Value of ${row.key || `key ${index + 1}`}`"
          />
        </div>
        <p v-if="shownProblem(row)" class="mt-1 text-xs text-destructive" role="alert">{{ shownProblem(row) }}</p>
      </li>
    </ul>

    <Button variant="ghost" size="xs" class="-ml-2 text-muted-foreground" @click="add">
      <Plus class="h-3.5 w-3.5" /> Add {{ noun }}
    </Button>

    <p v-if="tooLarge" class="text-xs text-destructive" role="alert">
      All annotations together can be 256 KiB at most.
    </p>

    <div v-if="changes.length" class="rounded-lg border border-border-subtle bg-surface-1/60 px-3 py-2">
      <div class="mb-1 text-xs text-muted-foreground">
        {{ changes.length === 1 ? "1 change" : `${changes.length} changes` }}
      </div>
      <ul class="space-y-0.5 font-mono text-xs">
        <li v-for="change in changes" :key="change.key" class="flex min-w-0 gap-2">
          <span
            class="w-3 shrink-0 text-center"
            :class="change.type === 'add' ? 'text-success' : change.type === 'remove' ? 'text-destructive' : 'text-warning'"
            aria-hidden="true"
            >{{ change.type === "add" ? "+" : change.type === "remove" ? "−" : "~" }}</span
          >
          <span class="sr-only">{{ change.type === "add" ? "Add" : change.type === "remove" ? "Remove" : "Change" }}</span>
          <span class="min-w-0 break-all">
            <span :class="change.type === 'remove' ? 'text-muted-foreground line-through' : ''">{{ change.key }}</span>
            <template v-if="change.type === 'add'"
              ><span class="text-muted-foreground">{{ type === "labels" ? "=" : ": " }}</span>{{ preview(change.after) }}</template
            >
            <template v-else-if="change.type === 'change'"
              ><span class="text-muted-foreground">: {{ preview(change.before) }} → </span>{{ preview(change.after) }}</template
            >
          </span>
        </li>
      </ul>
    </div>

    <div
      v-if="error"
      class="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-foreground"
      role="alert"
    >
      {{ error }}
    </div>

    <div class="flex items-center justify-end gap-1.5">
      <Button variant="ghost" size="sm" @click="cancel">Cancel</Button>
      <Button size="sm" :disabled="!valid || changes.length === 0 || saving" @click="save">
        {{ saving ? "Saving…" : changes.length > 1 ? `Save ${changes.length} changes` : "Save" }}
      </Button>
    </div>
  </div>

  <!-- Labels: compact key=value chips -->
  <div v-else-if="type === 'labels'" class="flex flex-wrap gap-1.5">
    <span
      v-for="[key, value] in shown"
      :key="key"
      class="inline-flex h-6 max-w-full items-center overflow-hidden rounded-md bg-muted px-2 font-mono text-xs select-text"
      :title="`${key}=${value}`"
    >
      <span class="truncate text-muted-foreground">{{ key }}</span>
      <span class="text-muted-foreground/60">=</span>
      <span class="truncate text-foreground">{{ value }}</span>
    </span>
    <Button
      v-if="total > PREVIEW_COUNT"
      size="xs"
      variant="ghost"
      class="text-muted-foreground"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show less" : `+${total - PREVIEW_COUNT} more` }}
    </Button>
    <span v-if="total === 0" class="text-xs text-muted-foreground">No labels</span>
  </div>

  <!-- Annotations: values can be long (JSON, URLs): a list -->
  <div v-else>
    <dl class="divide-y divide-border-subtle">
      <div v-for="[key, value] in shown" :key="key" class="py-2 first:pt-0 last:pb-0">
        <dt class="truncate font-mono text-xs text-muted-foreground" :title="key">{{ key }}</dt>
        <dd v-if="!isLong(key, value)" class="break-all font-mono text-xs text-foreground select-text">
          {{ value }}
        </dd>
        <dd v-else class="mt-0.5">
          <button
            type="button"
            class="group/value flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-xs focus-ring focus-visible:ring-offset-card"
            :aria-expanded="opened.has(key)"
            @click="toggle(key)"
          >
            <ChevronRight
              class="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-fast"
              :class="opened.has(key) ? 'rotate-90' : ''"
            />
            <span v-if="LONG_TITLES[key] || opened.has(key)" class="text-foreground">{{
              LONG_TITLES[key] ?? (detectFormat(value, key) === "json" ? "JSON" : "Text")
            }}</span>
            <span v-else class="min-w-0 truncate font-mono text-foreground">{{ value }}</span>
            <span class="ml-auto shrink-0 tabular-nums text-muted-foreground">{{ sizeWords(value) }}</span>
          </button>
          <CodeValue v-if="opened.has(key)" class="mt-1.5" :value="value" :format="detectFormat(value, key)" />
        </dd>
      </div>
    </dl>
    <Button
      v-if="total > PREVIEW_COUNT"
      size="xs"
      variant="ghost"
      class="mt-1 -ml-2 text-muted-foreground"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show less" : `+${total - PREVIEW_COUNT} more` }}
    </Button>
    <span v-if="total === 0" class="text-xs text-muted-foreground">No annotations</span>
  </div>
</template>
