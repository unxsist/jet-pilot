<script setup lang="ts">
import { type HTMLAttributes, nextTick } from "vue";
import { useVModel } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { fieldBase } from ".";

const el = ref<HTMLInputElement | null>(null);

const props = defineProps<{
  defaultValue?: string | number;
  modelValue?: string | number;
  class?: HTMLAttributes["class"];
}>();

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void;
}>();

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
});

const focus = async () => {
  await nextTick();
  el.value?.focus();
};

defineExpose({
  focus,
});
</script>

<template>
  <input
    ref="el"
    v-model="modelValue"
    :class="
      cn(
        fieldBase,
        'flex h-8 px-2.5 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        props.class
      )
    "
  />
</template>
