<script setup lang="ts">
/*
 * Plain YAML editor for Helm values: monospace textarea with a line number
 * gutter; Tab / Shift+Tab indent and outdent by two spaces. Deliberately
 * not Monaco: no remote loader, instant, and values files are small.
 */
const props = defineProps<{
  modelValue: string;
  invalid?: boolean;
  label?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const gutter = ref<HTMLDivElement | null>(null);

const lineCount = computed(() => Math.max(1, props.modelValue.split("\n").length));

const syncScroll = () => {
  if (gutter.value && textarea.value) {
    gutter.value.scrollTop = textarea.value.scrollTop;
  }
};

const update = (value: string, selectionStart: number, selectionEnd: number) => {
  emit("update:modelValue", value);
  nextTick(() => {
    textarea.value?.setSelectionRange(selectionStart, selectionEnd);
  });
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
  const element = event.target as HTMLTextAreaElement;
  event.preventDefault();

  const { selectionStart: start, selectionEnd: end, value } = element;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;

  if (!event.shiftKey && start === end) {
    update(value.slice(0, start) + "  " + value.slice(end), start + 2, start + 2);
    return;
  }

  // Indent / outdent every selected line.
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  const changed = event.shiftKey
    ? lines.map((line) => line.replace(/^ {1,2}/, ""))
    : lines.map((line) => "  " + line);
  const replaced = changed.join("\n");
  const firstDelta = changed[0].length - lines[0].length;
  update(
    value.slice(0, lineStart) + replaced + value.slice(end),
    Math.max(lineStart, start + firstDelta),
    end + (replaced.length - block.length)
  );
};
</script>

<template>
  <div
    class="flex h-full min-h-0 overflow-hidden bg-background font-mono text-xs leading-5"
    :class="invalid ? 'ring-1 ring-inset ring-destructive/50' : ''"
  >
    <div
      ref="gutter"
      class="w-12 shrink-0 select-none overflow-hidden border-r border-border-subtle bg-surface-1 py-2 pr-2 text-right tabular-nums text-muted-foreground"
      aria-hidden="true"
    >
      <div v-for="n in lineCount" :key="n">{{ n }}</div>
    </div>
    <textarea
      ref="textarea"
      :value="modelValue"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      wrap="off"
      :aria-label="label ?? 'Values (YAML)'"
      :aria-invalid="invalid ? 'true' : undefined"
      class="h-full min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-foreground outline-none"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @scroll="syncScroll"
      @keydown="onKeydown"
    />
  </div>
</template>
