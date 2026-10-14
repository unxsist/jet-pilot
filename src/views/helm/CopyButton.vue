<script setup lang="ts">
import { Check, Copy } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { error } from "@/lib/logger";

/* A quiet copy button: a check for a moment once copied. */
const props = withDefaults(
  defineProps<{ text: string; label?: string; showLabel?: boolean }>(),
  { label: "Copy", showLabel: false }
);

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const copy = async () => {
  try {
    await writeText(props.text);
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    error(`Failed to copy to the clipboard: ${e}`);
  }
};

onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <button
    type="button"
    class="inline-flex h-6 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-xs text-muted-foreground transition-colors duration-fast ease-out hover:bg-accent hover:text-foreground focus-ring"
    :aria-label="copied ? 'Copied' : label"
    :title="copied ? 'Copied' : label"
    @click.stop="copy"
  >
    <Check v-if="copied" class="h-3.5 w-3.5 text-success" />
    <Copy v-else class="h-3.5 w-3.5" />
    <span v-if="showLabel">{{ copied ? "Copied" : label }}</span>
  </button>
</template>
