<script setup lang="ts">
import type { Health } from "@/lib/clusterGraph";
import type { Rect } from "@/lib/clusterGraphLayout";

/*
 * Overview of the whole graph: application groups in their health colour
 * and the visible area. Click or drag to move the view there. Drawn from
 * the layout (not from vue-flow), so it covers what is not rendered.
 */
const props = defineProps<{
  groups: { id: string; rect: Rect; health: Health; app: boolean }[];
  bounds: Rect;
  view: Rect | null;
}>();
const emit = defineEmits<{ (e: "navigate", x: number, y: number): void }>();

const WIDTH = 200;
const PAD = 40;
const height = computed(() =>
  Math.round(
    Math.min(150, Math.max(70, (WIDTH * props.bounds.height) / props.bounds.width))
  )
);
const viewBox = computed(
  () =>
    `${props.bounds.x - PAD} ${props.bounds.y - PAD} ${props.bounds.width + PAD * 2} ${props.bounds.height + PAD * 2}`
);
/* Stroke widths in graph units for a ~1px line at minimap scale. */
const unit = computed(
  () =>
    Math.max(
      (props.bounds.width + PAD * 2) / WIDTH,
      (props.bounds.height + PAD * 2) / height.value
    )
);

const svg = ref<SVGSVGElement | null>(null);
const dragging = ref(false);
const navigate = (event: PointerEvent) => {
  const element = svg.value;
  const matrix = element?.getScreenCTM();
  if (!element || !matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix.inverse()
  );
  emit("navigate", point.x, point.y);
};
const onPointerDown = (event: PointerEvent) => {
  dragging.value = true;
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
  navigate(event);
};
const onPointerMove = (event: PointerEvent) => {
  if (dragging.value) navigate(event);
};
const onPointerUp = () => (dragging.value = false);
</script>

<template>
  <div
    class="graph-minimap overflow-hidden rounded-lg border bg-popover shadow-md"
  >
    <svg
      ref="svg"
      :width="WIDTH"
      :height="height"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      class="block cursor-pointer"
      role="img"
      aria-label="Minimap: click to move the view"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <rect
        v-for="group in groups"
        :key="group.id"
        :x="group.rect.x"
        :y="group.rect.y"
        :width="group.rect.width"
        :height="group.rect.height"
        :rx="unit * 2"
        :class="['mm-group', `mm-${group.app ? group.health : 'shared'}`]"
      />
      <rect
        v-if="view"
        :x="view.x"
        :y="view.y"
        :width="view.width"
        :height="view.height"
        :rx="unit * 2"
        :stroke-width="unit * 1.5"
        class="mm-view"
      />
    </svg>
  </div>
</template>

<style scoped>
.mm-group {
  fill: hsl(var(--muted-foreground) / 0.28);
}
.mm-ok,
.mm-neutral {
  fill: hsl(var(--success) / 0.45);
}
.mm-warning {
  fill: hsl(var(--warning) / 0.9);
}
.mm-error {
  fill: hsl(var(--destructive));
}
.mm-shared {
  fill: hsl(var(--muted-foreground) / 0.22);
}
.mm-view {
  fill: hsl(var(--primary) / 0.08);
  stroke: hsl(var(--primary) / 0.8);
}
</style>
