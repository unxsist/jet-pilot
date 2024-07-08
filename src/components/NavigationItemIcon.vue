<script setup lang="ts">
import { defineAsyncComponent } from "vue";

const props = defineProps({
  name: {
    type: String,
    required: true,
  },
});

// refactor to if import fails, default back to default import
const icon = defineAsyncComponent(() =>
  import(`@/assets/icons/${props.name}.svg`).catch(
    () => import("@/assets/icons/k8s.svg")
  )
);
</script>

<template>
  <component :is="icon" class="w-3 min-w-[16px] content-center" />
</template>
