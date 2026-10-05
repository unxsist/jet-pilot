<script setup lang="ts">
/**
 * The input for one preference, chosen by its definition: switch, select or
 * segmented buttons, number field, text field (committed on Enter / blur,
 * Esc reverts) or a tag list.
 */
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@/components/ui/tags-input";
import { cn } from "@/lib/utils";
import type { SettingDefinition } from "@/lib/settings/types";

const props = defineProps<{
  def: SettingDefinition;
  modelValue: unknown;
  id: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const set = (value: unknown) => emit("update:modelValue", value);

/* Text: edited locally, committed on Enter / blur. */
const draft = ref(String(props.modelValue ?? ""));
watch(
  () => props.modelValue,
  (value) => (draft.value = String(value ?? ""))
);
const commitText = () => {
  if (draft.value !== props.modelValue) set(draft.value);
};
const revertText = (event: KeyboardEvent) => {
  draft.value = String(props.modelValue ?? "");
  (event.target as HTMLInputElement).blur();
};

const fractionDigits = computed(() => {
  if (props.def.type !== "number" || props.def.integer) return 0;
  return (String(props.def.step ?? 1).split(".")[1] ?? "").length;
});
</script>

<template>
  <Switch
    v-if="def.type === 'boolean'"
    :id="id"
    :checked="modelValue === true"
    @update:checked="set"
  />

  <Tabs
    v-else-if="def.type === 'enum' && def.control === 'segmented'"
    :model-value="String(modelValue)"
    @update:model-value="set"
  >
    <TabsList :id="id" :aria-label="def.label">
      <TabsTrigger
        v-for="option in def.options"
        :key="option.value"
        :value="option.value"
        :title="option.description"
        class="px-2.5"
      >
        {{ option.label }}
      </TabsTrigger>
    </TabsList>
  </Tabs>

  <Select
    v-else-if="def.type === 'enum'"
    :model-value="String(modelValue)"
    @update:model-value="set"
  >
    <SelectTrigger :id="id" class="w-44">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="option in def.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>

  <div v-else-if="def.type === 'number'" class="flex items-center gap-2">
    <NumberField
      :id="id"
      :model-value="Number(modelValue)"
      :min="def.min"
      :max="def.max"
      :step="def.step ?? 1"
      :format-options="{
        maximumFractionDigits: fractionDigits,
        useGrouping: false,
      }"
      class="w-32"
      @update:model-value="(value: number) => Number.isFinite(value) && set(value)"
    >
      <NumberFieldContent>
        <NumberFieldDecrement />
        <NumberFieldInput :aria-label="def.label" />
        <NumberFieldIncrement />
      </NumberFieldContent>
    </NumberField>
    <span v-if="def.unit" class="text-xs text-muted-foreground">{{ def.unit }}</span>
  </div>

  <Input
    v-else-if="def.type === 'string'"
    :id="id"
    v-model="draft"
    :placeholder="def.placeholder"
    :maxlength="def.maxLength"
    spellcheck="false"
    autocomplete="off"
    :class="cn('w-full sm:w-64', def.mono && 'font-mono text-xs')"
    @blur="commitText"
    @keydown.enter="commitText"
    @keydown.esc.stop="revertText"
  />

  <TagsInput
    v-else-if="def.type === 'string[]'"
    :id="id"
    :model-value="(modelValue as string[]) ?? []"
    class="w-full sm:w-72"
    @update:model-value="(values: unknown[]) => set(values.map(String))"
  >
    <TagsInputItem v-for="item in (modelValue as string[]) ?? []" :key="item" :value="item">
      <TagsInputItemText />
      <TagsInputItemDelete />
    </TagsInputItem>
    <TagsInputInput :placeholder="def.placeholder" />
  </TagsInput>
</template>
