<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const mousePosition = ref({ x: 0, y: 0 });
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

const spotlightStyle = computed(() => ({
  maskImage: `radial-gradient(circle 400px at ${mousePosition.value.x}px ${mousePosition.value.y}px, 
                white, 
                rgba(255, 255, 255, 0.3) 40%, 
                transparent 70%)`,
  WebkitMaskImage: `radial-gradient(circle 400px at ${mousePosition.value.x}px ${mousePosition.value.y}px, 
                white, 
                rgba(255, 255, 255, 0.3) 40%, 
                transparent 70%)`,
}));
</script>

<template>
  <div ref="spotlightGrid" class="spotlight-grid w-full h-full">
    <div class="grid-lines"></div>
    <div class="grid-lines spotlight" :style="spotlightStyle"></div>
    <slot />
  </div>
</template>

<style scoped>
.spotlight-grid {
  --grid-size: 35px;
  --grid-offset: 12px;
  --background-color: #1a1a1a;
  --grid-color: rgba(255, 255, 255, 0.02);
  --grid-color-highlight: rgba(255, 255, 255, 0.1);

  position: relative;
  width: 100%;
  height: 100%;
  background-color: var(--background);
  overflow: hidden;
}

.grid-lines {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: linear-gradient(
      to right,
      var(--grid-color) 1px,
      transparent 1px
    ),
    linear-gradient(to bottom, var(--grid-color) 1px, transparent 1px);
  background-size: var(--grid-size) var(--grid-size);
  background-position: var(--grid-offset) var(--grid-offset);
}

.grid-lines.spotlight {
  background-image: linear-gradient(
      to right,
      var(--grid-color-highlight) 1px,
      transparent 1px
    ),
    linear-gradient(to bottom, var(--grid-color-highlight) 1px, transparent 1px);
  pointer-events: none;
}
</style>
