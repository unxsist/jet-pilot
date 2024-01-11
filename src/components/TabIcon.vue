<script setup lang="ts">
import { defineAsyncComponent } from "vue";

const props = defineProps({
  name: {
    type: String,
    required: true,
  },
});

const icon = defineAsyncComponent(
  () => import(`@/assets/icons/${props.name}.svg`)
);
</script>

<template>
  <component :is="icon" class="w-[14px] min-w-[14px] content-center" />
</template>
