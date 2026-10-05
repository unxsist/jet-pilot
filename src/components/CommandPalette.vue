<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import { whenIdle } from "@/lib/perf";
import {
  CommandPaletteStateKey,
  OpenCommandPaletteKey,
  CloseCommandPaletteKey,
} from "@/providers/CommandPaletteProvider";

/*
 * Keyboard entry point of the command palette. The dialog itself (with its
 * fuzzy search) is a separate chunk, loaded the first time the palette
 * opens and kept mounted afterwards.
 */
const CommandPaletteDialog = defineAsyncComponent(
  () => import("./command-palette/CommandPaletteDialog.vue")
);

const { open } = injectStrict(CommandPaletteStateKey);
const openCommandPalette = injectStrict(OpenCommandPaletteKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);

const loaded = ref(false);
watch(
  open,
  (isOpen) => {
    if (isOpen) loaded.value = true;
  },
  { immediate: true }
);

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (
    event.key.toLowerCase() !== "k" ||
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.repeat
  ) {
    return;
  }

  event.preventDefault();
  if (open.value) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
});

/* Warm the chunk once the app is idle so the first open is instant too. */
onMounted(() =>
  whenIdle(() => import("./command-palette/CommandPaletteDialog.vue"), 5000)
);
</script>
<template>
  <CommandPaletteDialog v-if="loaded" />
</template>
