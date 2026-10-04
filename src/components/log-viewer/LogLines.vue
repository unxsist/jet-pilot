<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
  LogRow,
  formatLogTime,
  highlightSegments,
  levelClass,
  logLevelOf,
} from "@/lib/logViewer";

/*
 * Virtualized log lines. Only the visible rows are rendered, so tens of
 * thousands of lines and frequent appends stay cheap. Without wrapping
 * every row has a fixed height (no measuring); with wrapping rows are
 * measured. `stickToBottom` follows new lines; scrolling up releases it,
 * scrolling back to the end re-engages it.
 */
const props = defineProps<{
  rows: LogRow[];
  showTimestamps: boolean;
  wrap: boolean;
  showSource: boolean;
  /* Width of the source column in characters. */
  sourceWidth: number;
  sourceLabel: (row: LogRow) => string;
  sourceHue: (row: LogRow) => number;
  query: string;
  /* Row index of the current search match. */
  activeIndex: number;
  stickToBottom: boolean;
}>();

const emit = defineEmits<{
  "update:stickToBottom": [value: boolean];
}>();

const ROW_HEIGHT = 20;

const scroller = ref<HTMLDivElement | null>(null);

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scroller.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index: number) => props.rows[index]?.seq ?? index,
  }))
);

const items = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

/* Measures wrapped rows (no-op without wrapping: fixed heights). */
const measure = (element: unknown) => {
  if (props.wrap && element instanceof Element) {
    virtualizer.value.measureElement(element);
  }
};

watch(
  () => props.wrap,
  () => {
    virtualizer.value.measure();
    if (props.stickToBottom) nextTick(scrollToBottom);
  }
);

let lastScrollTop = 0;
/* Jumping to a search match must not re-engage following. */
let skipScrollEvent = false;

const scrollToBottom = () => {
  const element = scroller.value;
  if (!element || props.rows.length === 0) return;
  if (props.wrap) {
    virtualizer.value.scrollToIndex(props.rows.length - 1, { align: "end" });
  }
  element.scrollTop = element.scrollHeight;
};

const scrollToIndex = (index: number) => {
  if (index < 0 || index >= props.rows.length) return;
  skipScrollEvent = true;
  virtualizer.value.scrollToIndex(index, { align: "center" });
};

defineExpose({ scrollToBottom, scrollToIndex });

/* Follow new lines while stuck to the bottom. */
watch(
  () => props.rows,
  () => {
    if (props.stickToBottom) nextTick(scrollToBottom);
  }
);

watch(
  () => props.stickToBottom,
  (stick) => {
    if (stick) nextTick(scrollToBottom);
  }
);


/*
 * Only an upward scroll by the user releases the bottom: new lines grow
 * the content between our scroll and the scroll event, so "not at the
 * bottom" alone doesn't mean the user scrolled away.
 */
const onScroll = () => {
  const element = scroller.value;
  if (!element) return;
  const scrolledUp = element.scrollTop < lastScrollTop - 2;
  lastScrollTop = element.scrollTop;
  const atBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT * 1.5;

  if (skipScrollEvent) {
    skipScrollEvent = false;
    return;
  }

  if (props.stickToBottom && scrolledUp && !atBottom) {
    emit("update:stickToBottom", false);
  } else if (!props.stickToBottom && atBottom) {
    emit("update:stickToBottom", true);
  }
};

const segments = (row: LogRow) =>
  props.query
    ? highlightSegments(row.content, props.query)
    : [{ text: row.content, match: false }];

const rowTone = (row: LogRow) => {
  const level = logLevelOf(row.data);
  const text = levelClass(level);
  if (text === "text-destructive") return { text, row: "bg-destructive/[0.06]" };
  if (text === "text-warning") return { text, row: "bg-warning/[0.05]" };
  return { text, row: "" };
};

const sourceTitle = (row: LogRow) =>
  [row.pod, row.container].filter(Boolean).join(" / ");
</script>

<template>
  <div
    ref="scroller"
    class="relative h-full w-full overflow-auto bg-background font-mono text-xs leading-5 select-text"
    role="log"
    aria-live="off"
    tabindex="0"
    @scroll.passive="onScroll"
  >
    <div
      class="relative"
      :class="wrap ? 'w-full' : 'w-max min-w-full'"
      :style="{ height: `${totalSize + 8}px` }"
    >
      <div
        v-for="item in items"
        :key="String(item.key)"
        :ref="measure"
        :data-index="item.index"
        class="absolute left-0 top-0 flex gap-3 px-3"
        :class="[
          wrap ? 'w-full' : 'w-max min-w-full',
          rows[item.index] && rowTone(rows[item.index]).row,
          item.index === activeIndex
            ? '!bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]'
            : 'hover:bg-accent/60',
        ]"
        :style="{
          transform: `translateY(${item.start + 4}px)`,
          minHeight: `${ROW_HEIGHT}px`,
        }"
      >
        <template v-if="rows[item.index]">
          <span
            v-if="showTimestamps"
            class="shrink-0 tabular-nums text-muted-foreground"
            :title="rows[item.index].timestamp"
            >{{ formatLogTime(rows[item.index].timestamp) }}</span
          >
          <span
            v-if="showSource"
            class="shrink-0 truncate text-[hsl(var(--pod-h)_62%_36%)] dark:text-[hsl(var(--pod-h)_78%_72%)]"
            :style="{
              width: `${sourceWidth}ch`,
              '--pod-h': sourceHue(rows[item.index]),
            }"
            :title="sourceTitle(rows[item.index])"
            >{{ sourceLabel(rows[item.index]) }}</span
          >
          <span
            class="min-w-0"
            :class="[
              wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
              rowTone(rows[item.index]).text,
            ]"
            ><template
              v-for="(segment, i) in segments(rows[item.index])"
              :key="i"
              ><mark
                v-if="segment.match"
                class="rounded-[3px] bg-warning/25 px-px text-foreground"
                >{{ segment.text }}</mark
              ><template v-else>{{ segment.text }}</template></template
            ></span
          >
        </template>
      </div>
    </div>
    <div
      v-if="rows.length === 0"
      class="absolute inset-0 flex items-center justify-center font-sans"
    >
      <slot name="empty" />
    </div>
  </div>
</template>
