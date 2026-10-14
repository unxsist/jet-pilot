<script setup lang="ts">
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { renderRemoteMarkdown } from "@/lib/markdown";

/*
 * A chart's README (remote content): sanitized HTML, typeset calmly,
 * links open in the browser. Images are dropped: the webview loads no
 * remote images.
 */
const props = defineProps<{ markdown: string }>();

const html = ref("");
watch(
  () => props.markdown,
  async (markdown) => {
    const rendered = await renderRemoteMarkdown(markdown);
    html.value = rendered.replace(/<img\b[^>]*>/gi, "");
  },
  { immediate: true }
);

const onClick = (event: MouseEvent) => {
  const link = (event.target as HTMLElement).closest("a");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (/^https?:\/\//.test(href)) openExternal(href);
};
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="chart-readme text-sm leading-relaxed text-foreground/90 select-text" @click="onClick" v-html="html" />
</template>

<style scoped lang="postcss">
.chart-readme {
  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    @apply mb-2 mt-6 font-semibold leading-snug text-foreground first:mt-0;
  }
  :deep(h1) {
    @apply text-lg;
  }
  :deep(h2) {
    @apply text-base;
  }
  :deep(h3),
  :deep(h4) {
    @apply text-sm;
  }
  :deep(p),
  :deep(ul),
  :deep(ol),
  :deep(pre),
  :deep(table) {
    @apply my-2.5;
  }
  :deep(ul) {
    @apply list-disc space-y-0.5 pl-5;
  }
  :deep(ol) {
    @apply list-decimal space-y-0.5 pl-5;
  }
  :deep(a) {
    @apply text-link underline-offset-2 hover:underline;
  }
  :deep(code) {
    @apply rounded bg-muted px-1 font-mono text-xs;
  }
  :deep(pre) {
    @apply overflow-x-auto rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-xs leading-5;
  }
  :deep(pre code) {
    @apply bg-transparent p-0;
  }
  :deep(table) {
    @apply block overflow-x-auto text-xs;
  }
  :deep(th),
  :deep(td) {
    @apply border-b border-border-subtle py-1.5 pr-3 text-left align-top;
  }
  :deep(th) {
    @apply font-medium text-foreground;
  }
  :deep(blockquote) {
    @apply border-l-2 pl-3 text-muted-foreground;
  }
}
</style>
