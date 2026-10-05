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
const OVERSCAN = 12;
/* Space above the first and below the last row. */
const PADDING = 8;
/* Without wrapping, longer lines are cut when rendered (shaping huge lines
 * is expensive); wrapping or exporting shows them in full. */
const MAX_RENDERED_CHARS = 2000;

const scroller = ref<HTMLDivElement | null>(null);

/*
 * Wrapped rows have variable heights: TanStack Virtual measures them. Its
 * bookkeeping is O(rows) per change though, so fixed-height rows (the
 * default) use plain O(1) windowing on the scroll position.
 */
const virtualizer = useVirtualizer(
  computed(() => {
    // Read the (plain) array once instead of through the props proxy: the
    // virtualizer calls getItemKey for every row on each change.
    const rows = props.rows;
    return {
      count: props.wrap ? rows.length : 0,
      getScrollElement: () => scroller.value,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index: number) => rows[index]?.seq ?? index,
    };
  })
);

const scrollTop = ref(0);
const viewportHeight = ref(0);
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = scroller.value?.clientHeight ?? 0;
  });
  if (scroller.value) resizeObserver.observe(scroller.value);
});
onUnmounted(() => resizeObserver?.disconnect());

interface WindowItem {
  index: number;
  key: number;
  start: number;
}

const fixedItems = computed<WindowItem[]>(() => {
  const rows = props.rows;
  const count = rows.length;
  const visible = Math.ceil(viewportHeight.value / ROW_HEIGHT) + 1;
  // Following: render the end directly, the scroll position catches up.
  const first = props.stickToBottom
    ? Math.max(0, count - visible - OVERSCAN)
    : Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, first + visible + 2 * OVERSCAN);
  const items: WindowItem[] = [];
  for (let index = first; index < last; index++) {
    items.push({ index, key: rows[index].seq, start: index * ROW_HEIGHT });
  }
  return items;
});

const items = computed<WindowItem[]>(() =>
  props.wrap
    ? virtualizer.value
        .getVirtualItems()
        .map((item) => ({ index: item.index, key: Number(item.key), start: item.start }))
    : fixedItems.value
);
const totalSize = computed(() =>
  props.wrap ? virtualizer.value.getTotalSize() : props.rows.length * ROW_HEIGHT
);

const displayText = (row: LogRow) =>
  !props.wrap && row.content.length > MAX_RENDERED_CHARS
    ? `${row.content.slice(0, MAX_RENDERED_CHARS)} … (${(
        row.content.length - MAX_RENDERED_CHARS
      ).toLocaleString()} more characters, wrap lines to see all)`
    : row.content;

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
    element.scrollTop = element.scrollHeight;
    return;
  }
  // The browser clamps; no layout read needed for fixed rows.
  element.scrollTop = totalSize.value + PADDING;
};

/* Scrolling forces a layout: do it once per frame, right before painting. */
let bottomFrame = 0;
const scheduleBottom = () => {
  if (bottomFrame) return;
  bottomFrame = requestAnimationFrame(() => {
    bottomFrame = 0;
    if (props.stickToBottom) scrollToBottom();
  });
};
onUnmounted(() => cancelAnimationFrame(bottomFrame));

const scrollToIndex = (index: number) => {
  if (index < 0 || index >= props.rows.length) return;
  skipScrollEvent = true;
  if (props.wrap) {
    virtualizer.value.scrollToIndex(index, { align: "center" });
    return;
  }
  const top = Math.max(0, index * ROW_HEIGHT - viewportHeight.value / 2);
  scrollTop.value = top;
  if (scroller.value) scroller.value.scrollTop = top;
};

defineExpose({ scrollToBottom, scrollToIndex });

/* Follow new lines while stuck to the bottom. */
watch(
  () => props.rows,
  () => {
    if (props.stickToBottom) scheduleBottom();
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
  const top = element.scrollTop;
  const scrolledUp = top < lastScrollTop - 2;
  lastScrollTop = top;
  if (!props.wrap) scrollTop.value = top;
  const atBottom =
    totalSize.value + PADDING - top - viewportHeight.value < ROW_HEIGHT * 1.5;

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
    ? highlightSegments(displayText(row), props.query)
    : [{ text: displayText(row), match: false }];

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
    class="relative h-full w-full overflow-auto bg-background font-mono text-xs leading-5 select-text [contain:strict]"
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
