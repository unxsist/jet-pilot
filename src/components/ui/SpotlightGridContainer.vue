<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

/*
 * Canvas with a subtle dot grid; dots near the pointer are brightened by a
 * radial mask (a static effect, so it is fine with reduced motion).
 */
const mousePosition = ref({ x: -1000, y: -1000 });
const spotlightGrid = ref<HTMLDivElement | null>(null);

const updateMousePosition = (ev: MouseEvent) => {
  if (spotlightGrid.value) {
    const rect = spotlightGrid.value.getBoundingClientRect();
    mousePosition.value = {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
    };
  }
};

onMounted(() => {
  window.addEventListener("mousemove", updateMousePosition);
});

onUnmounted(() => {
  window.removeEventListener("mousemove", updateMousePosition);
});

const spotlightStyle = computed(() => {
  const mask = `radial-gradient(circle 320px at ${mousePosition.value.x}px ${mousePosition.value.y}px, white, rgba(255, 255, 255, 0.25) 45%, transparent 75%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
});
</script>

<template>
  <div ref="spotlightGrid" class="spotlight-grid relative h-full w-full">
    <div class="grid-dots" aria-hidden="true"></div>
    <div
      class="grid-dots spotlight"
      :style="spotlightStyle"
      aria-hidden="true"
    ></div>
    <slot />
  </div>
</template>

<style scoped>
.spotlight-grid {
  --grid-size: 20px;
  position: relative;
  width: 100%;
  height: 100%;
  background-color: hsl(var(--background));
  overflow: hidden;
}

.grid-dots {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(
    circle at 1px 1px,
    hsl(var(--foreground) / 0.09) 1px,
    transparent 0
  );
  background-size: var(--grid-size) var(--grid-size);
}

.grid-dots.spotlight {
  background-image: radial-gradient(
    circle at 1px 1px,
    hsl(var(--primary) / 0.45) 1px,
    transparent 0
  );
}
</style>
