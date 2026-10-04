<script setup lang="ts">
import { Input } from "@/components/ui/input";

/*
 * Debug image choice: presets as a radio group plus a custom image.
 * v-model is the image reference.
 */
const props = defineProps<{
  modelValue: string;
  presets: { image: string; label: string; description: string }[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const isPreset = computed(() => props.presets.some((p) => p.image === props.modelValue));
const custom = ref(isPreset.value ? "" : props.modelValue);
const customSelected = ref(!isPreset.value);

const choose = (image: string) => {
  customSelected.value = false;
  emit("update:modelValue", image);
};

const chooseCustom = () => {
  customSelected.value = true;
  emit("update:modelValue", custom.value);
};

watch(custom, (value) => {
  if (customSelected.value) emit("update:modelValue", value);
});

const onKeydown = (event: KeyboardEvent, index: number) => {
  const count = props.presets.length + 1;
  const next =
    event.key === "ArrowDown" ? (index + 1) % count : event.key === "ArrowUp" ? (index - 1 + count) % count : -1;
  if (next < 0) return;
  event.preventDefault();
  if (next < props.presets.length) choose(props.presets[next].image);
  else chooseCustom();
  const items = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>("[role=radio]");
  items?.[next]?.focus();
};
</script>

<template>
  <div role="radiogroup" aria-label="Debug image" class="grid gap-1.5">
    <button
      v-for="(preset, index) in presets"
      :key="preset.image"
      type="button"
      role="radio"
      :aria-checked="!customSelected && modelValue === preset.image"
      :tabindex="!customSelected && modelValue === preset.image ? 0 : -1"
      class="flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-fast focus-ring"
      :class="
        !customSelected && modelValue === preset.image
          ? 'border-primary/50 bg-primary/10'
          : 'hover:bg-accent'
      "
      @click="choose(preset.image)"
      @keydown="onKeydown($event, index)"
    >
      <span
        class="mt-1 h-3 w-3 shrink-0 rounded-full border"
        :class="
          !customSelected && modelValue === preset.image
            ? 'border-[4px] border-primary'
            : 'border-input'
        "
        aria-hidden="true"
      />
      <span class="min-w-0">
        <span class="block font-mono text-sm">{{ preset.image }}</span>
        <span class="block text-xs text-muted-foreground">{{ preset.description }}</span>
      </span>
    </button>
    <div
      role="radio"
      :aria-checked="customSelected"
      :tabindex="customSelected ? 0 : -1"
      class="flex items-center gap-2.5 rounded-md border px-3 py-2 transition-colors duration-fast focus-ring"
      :class="customSelected ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent'"
      @click="chooseCustom"
      @keydown="onKeydown($event, presets.length)"
    >
      <span
        class="h-3 w-3 shrink-0 rounded-full border"
        :class="customSelected ? 'border-[4px] border-primary' : 'border-input'"
        aria-hidden="true"
      />
      <Input
        v-model="custom"
        class="h-7 font-mono text-xs"
        placeholder="Custom image, e.g. ubuntu:24.04"
        aria-label="Custom image"
        @focus="chooseCustom"
      />
    </div>
  </div>
</template>
