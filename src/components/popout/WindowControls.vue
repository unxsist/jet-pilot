<script setup lang="ts">
/*
 * Minimize / maximize / close for a pop-out window on Windows and Linux
 * (no native title bar there; macOS shows its traffic lights). Closing a
 * pop-out window only closes that window.
 */
import { Minus, Square, X } from "lucide-vue-next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const emit = defineEmits<{ close: [] }>();

const buttonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring focus-visible:ring-offset-sidebar";

const current = () => getCurrentWebviewWindow();
const toggleMaximize = async () => {
  const window = current();
  if (await window.isMaximized()) await window.unmaximize();
  else await window.maximize();
};
</script>

<template>
  <div class="flex shrink-0 items-center gap-0.5">
    <button
      type="button"
      :class="buttonClass"
      aria-label="Minimize window"
      title="Minimize"
      @click="current().minimize()"
    >
      <Minus class="h-3.5 w-3.5" />
    </button>
    <button
      type="button"
      :class="buttonClass"
      aria-label="Maximize or restore window"
      title="Maximize / restore"
      @click="toggleMaximize"
    >
      <Square class="h-3 w-3" />
    </button>
    <button
      type="button"
      :class="[buttonClass, 'hover:bg-destructive/15 hover:text-destructive']"
      aria-label="Close window"
      title="Close window"
      @click="emit('close')"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
