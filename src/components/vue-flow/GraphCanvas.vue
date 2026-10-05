<script setup lang="ts">
import {
  GraphPalette,
  Scene,
  SceneHighlight,
  clearTextCache,
  drawScene,
  readPalette,
} from "@/lib/clusterGraphCanvas";
import type { GraphLod } from "@/lib/clusterGraphView";

/*
 * The canvas layer under the vue-flow cards: lanes and groups always,
 * cards and edges where none are mounted (zoomed out, or outside the
 * mounted window while the view moves). Redrawn in the same tick as the
 * viewport changes, so it never lags behind the DOM cards.
 */
const props = defineProps<{
  scene: Scene;
  viewport: { x: number; y: number; zoom: number };
  lod: GraphLod;
  mounted: Set<string>;
  highlight: SceneHighlight;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const size = shallowRef({ width: 0, height: 0, dpr: 1 });
let palette: GraphPalette | null = null;
let context: CanvasRenderingContext2D | null = null;

const draw = () => {
  const element = canvas.value;
  if (!element || !palette) return;
  context ??= element.getContext("2d");
  if (!context) return;
  const started = performance.now();
  const { width, height, dpr } = size.value;
  const { x, y, zoom } = props.viewport;
  drawScene(
    context,
    props.scene,
    { x, y, zoom, width, height, dpr },
    palette,
    props.highlight,
    { lod: props.lod, mounted: props.mounted }
  );
  // For the performance harness.
  (window as any).__graphCanvasMs = performance.now() - started;
};

watch(
  () => [
    props.scene,
    props.viewport.x,
    props.viewport.y,
    props.viewport.zoom,
    props.lod,
    props.mounted,
    props.highlight,
    size.value,
  ],
  draw
);

/* Size: the canvas covers its container, at the device pixel ratio. */
let observer: ResizeObserver | null = null;
const resize = () => {
  const element = canvas.value;
  const parent = element?.parentElement;
  if (!element || !parent) return;
  const dpr = window.devicePixelRatio || 1;
  const width = parent.clientWidth;
  const height = parent.clientHeight;
  if (
    width === size.value.width &&
    height === size.value.height &&
    dpr === size.value.dpr
  ) {
    return;
  }
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  size.value = { width, height, dpr };
};

/* Theme tokens: re-read when the colour scheme changes. */
let themeObserver: MutationObserver | null = null;
const refreshPalette = () => {
  if (!canvas.value) return;
  palette = readPalette(canvas.value);
  draw();
};

onMounted(() => {
  refreshPalette();
  resize();
  observer = new ResizeObserver(resize);
  if (canvas.value?.parentElement) observer.observe(canvas.value.parentElement);
  themeObserver = new MutationObserver(refreshPalette);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  // Text is measured with the app font: redraw once it is loaded.
  document.fonts?.ready.then(() => {
    clearTextCache();
    draw();
  });
  draw();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  themeObserver?.disconnect();
});
</script>

<template>
  <canvas
    ref="canvas"
    class="graph-canvas pointer-events-none absolute inset-0 h-full w-full"
    aria-hidden="true"
  />
</template>
