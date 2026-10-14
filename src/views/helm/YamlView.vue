<script setup lang="ts">
/*
 * Read-only YAML that reads like a document: keys quiet, values in full
 * colour, comments faint. Instant (no editor to load) and selectable.
 */
const props = defineProps<{ text: string; maxHeight?: string }>();

interface Line {
  indent: string;
  marker: string;
  key: string;
  value: string;
  comment: string;
}

const LINE = /^(\s*)(- )?(?:([^\s#'"][^:#]*?|"[^"]*"|'[^']*'):(?=\s|$))?(\s*)(.*)$/;

const split = (line: string): Line => {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    return { indent: line.slice(0, line.length - trimmed.length), marker: "", key: "", value: "", comment: trimmed };
  }
  const match = LINE.exec(line);
  if (!match) return { indent: "", marker: "", key: "", value: line, comment: "" };
  const [, indent, marker = "", key = "", gap = "", rest = ""] = match;
  // A trailing comment (not inside quotes, roughly: after whitespace).
  const hash = rest.search(/\s#/);
  return {
    indent,
    marker,
    key: key ? `${key}:${gap}` : "",
    value: hash === -1 ? (key ? rest : gap + rest) : rest.slice(0, hash),
    comment: hash === -1 ? "" : rest.slice(hash),
  };
};

const lines = computed(() => props.text.replace(/\n$/, "").split("\n").map(split));
</script>

<template>
  <pre
    class="overflow-auto font-mono text-xs leading-5 select-text"
    :style="maxHeight ? { maxHeight } : undefined"
  ><template v-for="(line, i) in lines" :key="i"><span>{{ line.indent }}</span><span class="text-muted-foreground">{{ line.marker }}</span><span class="text-muted-foreground">{{ line.key }}</span><span class="text-foreground">{{ line.value }}</span><span class="italic text-muted-foreground/70">{{ line.comment }}</span>{{ "\n" }}</template></pre>
</template>
