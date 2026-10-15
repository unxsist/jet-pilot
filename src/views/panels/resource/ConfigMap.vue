<script setup lang="ts">
/**
 * A ConfigMap: its keys with their sizes; a value opens in place (JSON
 * pretty-printed, JSON and YAML lightly coloured) with a copy button. And
 * the pods that use it.
 */
import { Box, Check, ChevronRight, Copy, FileText } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import PanelSection from "@/components/generic/PanelSection.vue";
import CodeValue from "@/components/generic/CodeValue.vue";
import PodList from "@/components/generic/PodList.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { error } from "@/lib/logger";
import { bytesWords, detectFormat, sizeWords } from "@/lib/resources/highlight";
import { podUses } from "@/lib/resources/pod";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
const keys = computed(() => Object.keys(props.resource.data ?? {}).sort(byName));
const binaryKeys = computed(() => Object.keys(props.resource.binaryData ?? {}).sort(byName));
const value = (key: string) => String(props.resource.data?.[key] ?? "");
/* Short one-line values read best right next to their key. */
const inline = (key: string) => value(key).length <= 48 && !value(key).includes("\n");
/* binaryData is base64: four characters carry three bytes. */
const binarySize = (key: string) =>
  bytesWords(Math.floor((String(props.resource.binaryData?.[key] ?? "").replace(/=+$/, "").length * 3) / 4));
const FORMAT_LABELS = { json: "JSON", yaml: "YAML", text: "" } as const;

/* The first structured (or else the first long) value is open; the rest open on demand. */
const firstOpen = () => {
  const long = keys.value.filter((key) => !inline(key));
  const structured = long.find((key) => detectFormat(value(key), key) !== "text");
  return new Set<string>(structured ? [structured] : long.slice(0, 1));
};
const opened = ref(firstOpen());
const toggle = (key: string) => {
  const next = new Set(opened.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  opened.value = next;
};
watch(
  () => props.resource.metadata?.uid,
  () => (opened.value = firstOpen())
);

const copied = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const copy = async (key: string) => {
  try {
    await writeText(value(key));
    copied.value = key;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = null), 1500);
  } catch (e) {
    error(`Failed to copy to the clipboard: ${e}`);
  }
};
onUnmounted(() => clearTimeout(copiedTimer));

/* Pods that use it (env, volumes), from the namespace's pod watch. */
const { items: pods, loading } = useRelatedList(
  () => "Pod",
  () => target.value,
  () => (props.resource.metadata?.namespace ? [props.resource.metadata.namespace] : null)
);
const users = computed(() =>
  pods.value.filter((pod: any) =>
    podUses(pod).some((use) => use.kind === "ConfigMap" && use.ref?.name === props.resource.metadata?.name)
  )
);
</script>

<template>
  <PanelSection value="data" title="Data" :icon="FileText" :count="keys.length + binaryKeys.length">
    <div class="space-y-1">
      <p v-if="resource.immutable" class="mb-2 text-xs text-muted-foreground">Immutable: replace it to change a value.</p>
      <div v-for="key in keys" :key="key">
        <div class="group/key flex items-center gap-1">
          <div v-if="inline(key)" class="flex h-7 min-w-0 flex-1 items-center gap-2 px-1 pl-[1.375rem] text-xs">
            <span class="shrink-0 font-mono font-medium text-foreground">{{ key }}</span>
            <span class="min-w-0 truncate font-mono text-muted-foreground select-text" :title="value(key)">{{
              value(key) === "" ? '""' : value(key)
            }}</span>
          </div>
          <button
            v-else
            type="button"
            class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-xs transition-colors duration-fast hover:bg-accent/60 focus-ring focus-visible:ring-offset-card"
            :aria-expanded="opened.has(key)"
            @click="toggle(key)"
          >
            <ChevronRight
              class="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-fast"
              :class="opened.has(key) ? 'rotate-90' : ''"
            />
            <span class="min-w-0 truncate font-mono font-medium text-foreground">{{ key }}</span>
            <span class="ml-auto shrink-0 tabular-nums text-muted-foreground">
              <template v-if="FORMAT_LABELS[detectFormat(value(key), key)]">{{ FORMAT_LABELS[detectFormat(value(key), key)] }} · </template>{{ sizeWords(value(key)) }}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground"
            :aria-label="copied === key ? `${key} copied` : `Copy ${key}`"
            :title="copied === key ? 'Copied!' : 'Copy value'"
            @click="copy(key)"
          >
            <Check v-if="copied === key" class="h-3.5 w-3.5 text-success" />
            <Copy v-else class="h-3.5 w-3.5" />
          </Button>
        </div>
        <CodeValue v-if="opened.has(key)" class="mb-2 ml-5 mt-1" :value="value(key)" :format="detectFormat(value(key), key)" />
      </div>
      <div v-for="key in binaryKeys" :key="`binary-${key}`" class="flex h-7 items-center gap-1.5 px-1 pl-[1.375rem] text-xs">
        <span class="min-w-0 truncate font-mono font-medium">{{ key }}</span>
        <span class="ml-auto shrink-0 text-muted-foreground">Binary · {{ binarySize(key) }}</span>
      </div>
      <p v-if="!keys.length && !binaryKeys.length" class="text-xs text-muted-foreground">No data.</p>
    </div>
  </PanelSection>

  <PanelSection value="used-by" title="Used by" :icon="Box" :count="users.length">
    <PodList v-if="users.length" :pods="users" :now="now" />
    <p v-else-if="!loading" class="text-xs text-muted-foreground">No pod in {{ resource.metadata?.namespace }} uses it.</p>
  </PanelSection>
</template>
