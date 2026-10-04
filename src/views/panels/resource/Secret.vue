<script setup lang="ts">
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import EyeCloseIcon from "@/assets/icons/eye_close.svg";
import EyeOpenIcon from "@/assets/icons/eye_open.svg";
import CopyIcon from "@/assets/icons/copy.svg";
import { Check, KeyRound } from "lucide-vue-next";
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
  <AccordionItem class="px-4" value="data">
    <AccordionTrigger>
      <div class="flex items-center gap-2"><KeyRound class="h-4" /> Data</div>
    </AccordionTrigger>
    <AccordionContent>
      <div class="space-y-4">
        <div v-for="key in Object.keys(resource.data || {})" :key="key">
          <div class="flex flex-col gap-2">
            <span class="font-mono">{{ key }}</span>
            <div class="relative overflow-hidden rounded">
              <div
                class="select-text border border-input rounded p-4 pr-10 break-all opacity-50 hover:opacity-100"
              >
                {{ getSecretData(key) }}
              </div>
              <div class="absolute right-0 top-0 flex">
                <button
                  v-if="decodedKeys.includes(key)"
                  type="button"
                  :aria-label="copiedKey === key ? `${key} copied` : `Copy ${key}`"
                  :title="copiedKey === key ? 'Copied!' : 'Copy value'"
                  @click="copySecret(key)"
                  class="rounded-bl-sm p-2 border-l border-b hover:bg-muted text-foreground flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Check
                    v-if="copiedKey === key"
                    class="h-4 w-4 text-green-600 dark:text-green-500"
                  />
                  <CopyIcon v-else class="h-4" />
                </button>
                <button
                  type="button"
                  :class="{
                    'rounded-bl-sm': !decodedKeys.includes(key),
                  }"
                  :aria-label="
                    decodedKeys.includes(key) ? `Hide ${key}` : `Reveal ${key}`
                  "
                  :aria-pressed="decodedKeys.includes(key)"
                  :title="decodedKeys.includes(key) ? 'Hide value' : 'Reveal value'"
                  @click="toggleDecode(key)"
                  class="p-2 border-l border-b hover:bg-muted text-foreground flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <EyeCloseIcon v-if="decodedKeys.includes(key)" class="h-4" />
                  <EyeOpenIcon v-else class="h-4" />
                </button>
                <span class="sr-only" aria-live="polite">{{
                  copiedKey === key ? `${key} copied to the clipboard` : ""
                }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>
