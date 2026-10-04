<script setup lang="ts">
import PanelSection from "@/components/generic/PanelSection.vue";
import { Button } from "@/components/ui/button";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-vue-next";
import { V1Secret } from "@kubernetes/client-node";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { error } from "@/lib/logger";

const decodedKeys = ref<string[]>([]);
const props = defineProps<{ resource: V1Secret }>();

const toggleDecode = (key: string) => {
  if (decodedKeys.value.includes(key)) {
    decodedKeys.value = decodedKeys.value.filter((k) => k !== key);
  } else {
    decodedKeys.value = [...decodedKeys.value, key];
  }
};

const getSecretData = (key: string) => {
  if (!decodedKeys.value.includes(key)) {
    return props.resource.data![key];
  }

  return atob(props.resource.data![key]);
};

/* Briefly show a check mark on the copy button that was used. */
const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const copySecret = async (key: string) => {
  try {
    await writeText(getSecretData(key));
    copiedKey.value = key;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedKey.value = null), 1500);
  } catch (e) {
    error(`Failed to copy to the clipboard: ${e}`);
  }
};

onUnmounted(() => clearTimeout(copiedTimer));
</script>
<template>
  <PanelSection
    value="data"
    title="Data"
    :icon="KeyRound"
    :count="Object.keys(resource.data || {}).length"
  >
    <div class="space-y-3">
      <div v-for="key in Object.keys(resource.data || {})" :key="key">
        <div class="mb-1 flex items-center justify-between gap-2">
          <span class="truncate font-mono text-xs font-medium">{{ key }}</span>
          <div class="flex shrink-0 items-center gap-0.5">
            <Button
              v-if="decodedKeys.includes(key)"
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground"
              :aria-label="copiedKey === key ? `${key} copied` : `Copy ${key}`"
              :title="copiedKey === key ? 'Copied!' : 'Copy value'"
              @click="copySecret(key)"
            >
              <Check v-if="copiedKey === key" class="h-3.5 w-3.5 text-success" />
              <Copy v-else class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground"
              :aria-label="
                decodedKeys.includes(key) ? `Hide ${key}` : `Reveal ${key}`
              "
              :aria-pressed="decodedKeys.includes(key)"
              :title="decodedKeys.includes(key) ? 'Hide value' : 'Reveal value'"
              @click="toggleDecode(key)"
            >
              <EyeOff v-if="decodedKeys.includes(key)" class="h-3.5 w-3.5" />
              <Eye v-else class="h-3.5 w-3.5" />
            </Button>
            <span class="sr-only" aria-live="polite">{{
              copiedKey === key ? `${key} copied to the clipboard` : ""
            }}</span>
          </div>
        </div>
        <div
          class="max-h-40 overflow-auto break-all rounded-md border bg-surface-1 px-3 py-2 font-mono text-xs select-text"
          :class="
            decodedKeys.includes(key)
              ? 'text-foreground'
              : 'text-muted-foreground blur-[3px] transition-[filter] duration-base hover:blur-none'
          "
        >
          {{ getSecretData(key) }}
        </div>
      </div>
    </div>
  </PanelSection>
</template>
