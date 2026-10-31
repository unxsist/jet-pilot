<script setup lang="ts">
/*
 * "Equivalent kubectl command" in confirmation dialogs: a quiet disclosure
 * with the command line(s) that do the same, and a copy button. The
 * cluster flags are worked out when it opens (what kubectl would use by
 * itself can change from a terminal in the meantime).
 */
import { Check, ChevronRight, Copy } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { commandWords, type CommandSpec } from "@/lib/kubectl/command";
import { kubectlDefaults } from "@/lib/kubectl/defaults";

const props = defineProps<{ commands: CommandSpec[] }>();

/* Long selections: the first few lines, the copy has them all. */
const SHOWN = 6;

const open = ref(false);
/* Each line as its quoted words: a line only wraps between words. */
const lines = ref<string[][]>([]);
const copied = ref(false);

const title = computed(() => {
  const program = props.commands.every((c) => c.program === "helm") ? "helm" : "kubectl";
  return `Equivalent ${program} ${props.commands.length > 1 ? "commands" : "command"}`;
});

const resolve = async () => {
  const defaults = await kubectlDefaults(props.commands.map((c) => c.target));
  lines.value = props.commands.map((spec) => commandWords(spec, defaults));
};

watch(
  () => props.commands,
  () => {
    if (open.value) void resolve();
  }
);

const toggle = () => {
  open.value = !open.value;
  if (open.value) void resolve();
};

let reset: ReturnType<typeof setTimeout> | undefined;
const copy = async () => {
  await resolve();
  const text = lines.value.map((words) => words.join(" ")).join("\n");
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => {});
  }
  copied.value = true;
  clearTimeout(reset);
  reset = setTimeout(() => (copied.value = false), 1500);
};
onBeforeUnmount(() => clearTimeout(reset));
</script>

<template>
  <div class="text-xs">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
      :aria-expanded="open"
      @click="toggle"
    >
      <ChevronRight
        class="h-3.5 w-3.5 transition-transform duration-fast ease-out"
        :class="{ 'rotate-90': open }"
        aria-hidden="true"
      />
      {{ title }}
    </button>
    <div
      v-if="open && lines.length"
      class="relative mt-2 rounded-md border border-border-subtle bg-muted/40 py-2 pl-3 pr-9"
    >
      <div class="max-h-40 select-text overflow-auto font-mono text-xs leading-5 text-foreground">
        <div v-for="(words, index) in lines.slice(0, SHOWN)" :key="index">
          <template v-for="(word, w) in words" :key="w"
            ><span class="whitespace-nowrap">{{ word }}</span>{{ w < words.length - 1 ? " " : "" }}</template
          >
        </div>
      </div>
      <p v-if="lines.length > SHOWN" class="mt-1 text-2xs text-muted-foreground">
        … and {{ lines.length - SHOWN }} more (copied too)
      </p>
      <button
        type="button"
        class="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring"
        :aria-label="copied ? 'Copied' : 'Copy'"
        :title="copied ? 'Copied' : 'Copy'"
        @click="copy"
      >
        <Check v-if="copied" class="h-3.5 w-3.5 text-success" />
        <Copy v-else class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
