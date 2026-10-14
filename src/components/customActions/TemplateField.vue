<script setup lang="ts">
/*
 * A template in the action form: a monospace field and, under it, the
 * variables as quiet chips that insert `{{…}}` at the cursor.
 */
import { cn } from "@/lib/utils";
import { fieldBase } from "@/components/ui/input";

export interface TemplateVariable {
  /** Shown on the chip, e.g. "labels.app". */
  label: string;
  /** Inserted, e.g. "{{labels.app}}". */
  insert: string;
  title?: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    id?: string;
    rows?: number;
    placeholder?: string;
    /** Fixed text before the field, e.g. "kubectl". */
    prefix?: string;
    variables?: TemplateVariable[];
    invalid?: boolean;
  }>(),
  { rows: 1, variables: () => [] }
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const field = ref<HTMLTextAreaElement | HTMLInputElement | null>(null);

const insert = async (text: string) => {
  const element = field.value;
  const value = props.modelValue;
  const start = element?.selectionStart ?? value.length;
  const end = element?.selectionEnd ?? value.length;
  emit("update:modelValue", value.slice(0, start) + text + value.slice(end));
  await nextTick();
  element?.focus();
  element?.setSelectionRange(start + text.length, start + text.length);
};

const classes = computed(() =>
  cn(
    fieldBase,
    "w-full font-mono text-xs leading-5",
    props.rows > 1 ? "min-h-0 resize-y px-2.5 py-2" : "h-8 px-2.5",
    props.prefix && "rounded-l-none",
    props.invalid && "border-destructive/60 focus-visible:ring-destructive/20"
  )
);
</script>

<template>
  <div class="space-y-2">
    <div class="flex">
      <span
        v-if="prefix"
        class="flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-input bg-muted/60 px-2.5 font-mono text-xs text-muted-foreground"
        >{{ prefix }}</span
      >
      <textarea
        v-if="rows > 1"
        :id="id"
        ref="field"
        :value="modelValue"
        :rows="rows"
        :placeholder="placeholder"
        :class="classes"
        spellcheck="false"
        autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <input
        v-else
        :id="id"
        ref="field"
        :value="modelValue"
        :placeholder="placeholder"
        :class="classes"
        spellcheck="false"
        autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div v-if="variables.length" class="flex flex-wrap items-center gap-1" aria-label="Insert a variable">
      <button
        v-for="variable in variables"
        :key="variable.insert"
        type="button"
        class="h-6 rounded-md border border-border-subtle bg-surface-1 px-2 font-mono text-2xs text-muted-foreground transition-colors duration-fast hover:border-border hover:bg-accent hover:text-foreground focus-ring"
        :title="variable.title ?? `Insert ${variable.insert}`"
        @mousedown.prevent
        @click="insert(variable.insert)"
      >
        {{ variable.label }}
      </button>
    </div>
  </div>
</template>
