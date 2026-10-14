<script setup lang="ts">
/**
 * A word in a question that you can change ("Can I [list] [pods] in
 * [payments]?"): it reads like text, underlined, and opens a searchable
 * list. With `custom`, whatever you type can be used as is.
 */
import { Check } from "lucide-vue-next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TokenOption } from "./question";


const props = withDefaults(
  defineProps<{
    options: TokenOption[];
    /** Accessible name, e.g. "Verb". */
    label: string;
    placeholder?: string;
    /** Text shown for the current value (default: its option's label). */
    display?: string;
    custom?: boolean;
    /** Text of the "use what I typed" row. */
    customLabel?: (text: string) => string;
    class?: string;
  }>(),
  { placeholder: "anything", display: undefined, custom: false, customLabel: undefined, class: undefined }
);
const model = defineModel<string>({ required: true });

const open = ref(false);
const query = ref("");
const highlighted = ref(0);
const listElement = ref<HTMLElement | null>(null);

const current = computed(() => props.options.find((o) => o.value === model.value));
const text = computed(() => props.display ?? current.value?.label ?? (model.value || props.placeholder));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  const starts: TokenOption[] = [];
  const contains: TokenOption[] = [];
  for (const option of props.options) {
    const label = option.label.toLowerCase();
    if (label.startsWith(q) || option.value.toLowerCase().startsWith(q)) starts.push(option);
    else if (`${label} ${option.value} ${option.hint ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(q)) contains.push(option);
  }
  return [...starts, ...contains];
});

const customRow = computed(() => {
  const q = query.value.trim();
  if (!props.custom || !q || props.options.some((o) => o.value === q)) return null;
  return q;
});

type Row = { option: TokenOption; heading?: string } | { custom: string };
const rows = computed<Row[]>(() => {
  const list: Row[] = [];
  let section: string | undefined;
  for (const option of filtered.value) {
    const heading = !query.value && option.section !== section ? option.section : undefined;
    section = option.section;
    list.push({ option, heading });
  }
  if (customRow.value) list.push({ custom: customRow.value });
  return list;
});

watch(open, (isOpen) => {
  if (!isOpen) return;
  query.value = "";
  const index = filtered.value.findIndex((o) => o.value === model.value);
  highlighted.value = Math.max(0, index);
  nextTick(() => scrollToHighlighted());
});
watch(query, () => (highlighted.value = 0));

const scrollToHighlighted = () => {
  listElement.value?.querySelector(`[data-index="${highlighted.value}"]`)?.scrollIntoView({ block: "nearest" });
};

const choose = (row: Row | undefined) => {
  if (!row) return;
  model.value = "custom" in row ? row.custom : row.option.value;
  open.value = false;
};

const onKeydown = (event: KeyboardEvent) => {
  const count = rows.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!count) return;
    highlighted.value = (highlighted.value + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    nextTick(scrollToHighlighted);
  } else if (event.key === "Enter") {
    event.preventDefault();
    choose(rows.value[highlighted.value]);
  }
};
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger
      :class="
        cn(
          'token inline rounded-md px-1 py-0.5 font-medium text-foreground transition-colors duration-fast ease-out hover:bg-accent/70 focus-ring data-[state=open]:bg-accent',
          !current && !model && 'text-muted-foreground',
          props.class
        )
      "
      :aria-label="`${label}: ${text}`"
    >
      {{ text }}
    </PopoverTrigger>
    <PopoverContent align="start" class="w-64 p-0">
      <div class="border-b border-border-subtle p-1.5">
        <input
          v-model="query"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :aria-label="`Find a ${label.toLowerCase()}`"
          :placeholder="custom ? 'Find or type…' : 'Find…'"
          class="h-7 w-full rounded-md bg-transparent px-2 text-sm placeholder:text-muted-foreground/80 focus:outline-none"
          @keydown="onKeydown"
        />
      </div>
      <div ref="listElement" class="max-h-72 overflow-y-auto p-1" role="listbox" :aria-label="label">
        <template v-for="(row, index) in rows" :key="'custom' in row ? `custom:${row.custom}` : row.option.value">
          <div v-if="!('custom' in row) && row.heading" class="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
            {{ row.heading }}
          </div>
          <button
            type="button"
            role="option"
            :data-index="index"
            :aria-selected="'custom' in row ? false : row.option.value === model"
            class="flex min-h-[1.75rem] w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-sm outline-none transition-colors duration-75"
            :class="index === highlighted ? 'bg-accent text-accent-foreground' : ''"
            @mousemove="highlighted = index"
            @click="choose(row)"
          >
            <template v-if="'custom' in row">
              <span class="truncate">{{ customLabel ? customLabel(row.custom) : `Use “${row.custom}”` }}</span>
            </template>
            <template v-else>
              <span class="truncate">{{ row.option.label }}</span>
              <span v-if="row.option.hint" class="truncate text-xs text-muted-foreground">{{ row.option.hint }}</span>
              <Check v-if="row.option.value === model" class="ml-auto h-3.5 w-3.5 shrink-0 text-link" />
            </template>
          </button>
        </template>
        <p v-if="rows.length === 0" class="px-2 py-3 text-center text-xs text-muted-foreground">Nothing matches</p>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
/* A word you can change: a dashed underline that firms up on hover. Kept
   out of the utility classes, which all ship in the startup CSS. */
.token {
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-thickness: 1px;
  text-decoration-color: hsl(var(--border-strong));
  text-underline-offset: 6px;
}
.token:hover,
.token:focus,
.token[data-state="open"] {
  text-decoration-color: hsl(var(--foreground) / 0.5);
}
</style>
