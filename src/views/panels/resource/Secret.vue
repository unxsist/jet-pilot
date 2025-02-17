<script setup lang="ts">
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import EyeCloseIcon from "@/assets/icons/eye_close.svg";
import EyeOpenIcon from "@/assets/icons/eye_open.svg";
import CopyIcon from "@/assets/icons/copy.svg";
import { KeyRound } from "lucide-vue-next";
import { V1Secret } from "@kubernetes/client-node";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

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
                  @click="writeText(getSecretData(key))"
                  class="p-2 border-l border-b rounded-bl-sm hover:bg-muted text-white flex items-center justify-center"
                >
                  <CopyIcon class="h-4" />
                </button>
                <button
                  :class="{
                    'rounded-bl-sm': !decodedKeys.includes(key),
                  }"
                  @click="toggleDecode(key)"
                  class="p-2 border-l border-b hover:bg-muted text-white flex items-center justify-center"
                >
                  <EyeCloseIcon v-if="decodedKeys.includes(key)" class="h-4" />
                  <EyeOpenIcon v-else class="h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>
