<script setup lang="ts">
/**
 * A node's taints: what each one does, in words, and editable in place
 * (add, change, remove) with a preview and a guarded JSON patch that only
 * applies to the taints as they were read. Taints Kubernetes manages
 * itself (cordon, not-ready, ...) are shown but not edited.
 */
import { Lock, Plus, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { kubePatch } from "@/lib/kubeApi";
import { guard, rowTargets } from "@/lib/guardrails/guard";
import { refPath } from "@/lib/resources/kinds";
import type { PanelTarget } from "@/lib/resources/open";
import {
  TAINT_EFFECTS,
  TAINT_EFFECT_WORDS,
  diffTaints,
  editErrorMessage,
  isEditConflict,
  formatTaint,
  isSystemTaint,
  taintsPatch,
  validateTaint,
  type Taint,
  type TaintEffect,
} from "@/lib/resources/metadataEdit";

const props = defineProps<{ node: any; target: PanelTarget }>();
const editing = defineModel<boolean>("editing", { default: false });

const taints = computed<Taint[]>(() => props.node.spec?.taints ?? []);

interface Row extends Taint {
  id: number;
  system: boolean;
}
let nextId = 0;
const rows = ref<Row[]>([]);
const saving = ref(false);
const error = ref<string | null>(null);
const keyInputs = ref<InstanceType<typeof Input>[]>([]);

/*
 * The taints the edit started from: the patch tests them, so a taint
 * Kubernetes (or someone) adds meanwhile is never dropped silently.
 */
const base = shallowRef<Taint[] | undefined>(undefined);
const current = () => (props.node.spec?.taints ? structuredClone(toRaw(props.node.spec.taints)) : undefined);
watch(
  editing,
  (now) => {
    if (!now) return;
    base.value = current();
    rows.value = taints.value.map((t) => ({ ...t, value: t.value ?? "", id: nextId++, system: isSystemTaint(t) }));
    error.value = null;
  },
  { immediate: true }
);

const add = async () => {
  rows.value.push({ id: nextId++, key: "", value: "", effect: "NoSchedule", system: false });
  await nextTick();
  keyInputs.value[keyInputs.value.length - 1]?.focus();
};
const remove = (row: Row) => (rows.value = rows.value.filter((r) => r !== row));

const after = computed<Taint[]>(() =>
  rows.value
    .filter((row) => row.system || row.key !== "")
    .map(({ key, value, effect, timeAdded }) => ({ key: key.trim(), value: value?.trim() || undefined, effect, timeAdded }))
);
const problems = computed(
  () =>
    new Map(
      rows.value.map((row, index) => [
        row.id,
        row.system || row.key === ""
          ? null
          : validateTaint(
              { key: row.key.trim(), value: row.value?.trim(), effect: row.effect },
              rows.value.filter((_, i) => i !== index).map((r) => ({ ...r, key: r.key.trim() }))
            ),
      ])
    )
);
const changes = computed(() => diffTaints(base.value ?? [], after.value));
const valid = computed(() => [...problems.value.values()].every((p) => !p));
const evicts = computed(() =>
  changes.value.some((c) => c.type !== "remove" && c.key.endsWith(":NoExecute"))
);

const describeChange = (key: string) => {
  const [name, effect] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
  return { name, effect };
};

const cancel = () => {
  editing.value = false;
  error.value = null;
};

const save = async () => {
  const patch = taintsPatch(base.value, after.value);
  if (!patch || !valid.value || saving.value) return;
  if (!(await guard("edit-taints", rowTargets([props.node], "Node")))) return;
  saving.value = true;
  error.value = null;
  try {
    await kubePatch(
      { context: props.target.context, kubeConfig: props.target.kubeConfig || undefined },
      refPath({ kind: "Node", name: props.node.metadata?.name ?? "" })!,
      patch,
      "json"
    );
    editing.value = false;
  } catch (e) {
    error.value = editErrorMessage(e, "taints");
    // Changed meanwhile: the edit continues from the current taints.
    if (isEditConflict(e)) base.value = current();
  } finally {
    saving.value = false;
  }
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancel();
  } else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
    event.preventDefault();
    save();
  }
};
</script>

<template>
  <div v-if="editing" class="space-y-3" @keydown="onKeydown">
    <ul class="space-y-2">
      <li v-for="(row, index) in rows" :key="row.id">
        <div v-if="row.system" class="flex h-7 items-center gap-2 px-1 text-xs text-muted-foreground">
          <Lock class="h-3 w-3 shrink-0" />
          <span class="min-w-0 flex-1 truncate font-mono">{{ formatTaint(row) }}</span>
          <span class="shrink-0">Set by Kubernetes</span>
        </div>
        <div v-else class="flex items-center gap-1.5">
          <Input
            ref="keyInputs"
            v-model="row.key"
            placeholder="key"
            spellcheck="false"
            autocapitalize="off"
            class="h-7 min-w-0 flex-[3] font-mono text-xs"
            :aria-label="`Taint key ${index + 1}`"
            :aria-invalid="!!problems.get(row.id)"
          />
          <span class="text-xs text-muted-foreground">=</span>
          <Input
            v-model="row.value"
            placeholder="value"
            spellcheck="false"
            autocapitalize="off"
            class="h-7 min-w-0 flex-[2] font-mono text-xs"
            :aria-label="`Value of ${row.key || `taint ${index + 1}`}`"
          />
          <Select v-model="row.effect">
            <SelectTrigger class="h-7 w-[8.5rem] shrink-0 text-xs" :aria-label="`Effect of ${row.key || `taint ${index + 1}`}`">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="effect in TAINT_EFFECTS" :key="effect" :value="effect" class="text-xs">
                {{ effect }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground"
            :aria-label="`Remove ${row.key || 'this taint'}`"
            title="Remove"
            @click="remove(row)"
          >
            <X class="h-3.5 w-3.5" />
          </Button>
        </div>
        <p v-if="problems.get(row.id)" class="mt-1 text-xs text-destructive" role="alert">{{ problems.get(row.id) }}</p>
        <p v-else-if="!row.system" class="mt-1 text-xs text-muted-foreground">
          {{ TAINT_EFFECT_WORDS[row.effect as TaintEffect] }}
        </p>
      </li>
    </ul>

    <Button variant="ghost" size="xs" class="-ml-2 text-muted-foreground" @click="add">
      <Plus class="h-3.5 w-3.5" /> Add taint
    </Button>

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
          <span class="min-w-0 break-all" :class="change.type === 'remove' ? 'text-muted-foreground line-through' : ''">
            {{ describeChange(change.key).name
            }}<template v-if="change.after">={{ change.after }}</template>:{{ describeChange(change.key).effect }}
          </span>
        </li>
      </ul>
      <p v-if="evicts" class="mt-2 text-xs text-warning">
        NoExecute evicts the pods on this node that don't tolerate it, right away.
      </p>
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

  <ul v-else-if="taints.length" class="space-y-2.5">
    <li v-for="taint in taints" :key="`${taint.key}:${taint.effect}`" class="min-w-0">
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="min-w-0 truncate font-mono text-xs select-text" :title="formatTaint(taint)"
          >{{ taint.key }}<template v-if="taint.value"><span class="text-muted-foreground">=</span>{{ taint.value }}</template></span
        >
        <span
          class="shrink-0 text-xs"
          :class="taint.effect === 'NoExecute' ? 'text-warning' : 'text-muted-foreground'"
          >{{ taint.effect }}</span
        >
      </div>
      <p class="text-xs text-muted-foreground">
        {{ TAINT_EFFECT_WORDS[taint.effect as TaintEffect] ?? "" }}{{ isSystemTaint(taint) ? " · set by Kubernetes" : "" }}
      </p>
    </li>
  </ul>
  <p v-else class="text-xs text-muted-foreground">No taints: any pod may be scheduled here.</p>
</template>
