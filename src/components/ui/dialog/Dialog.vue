<script setup lang="ts">
import { DialogRoot, type DialogRootProps } from "radix-vue";

const props = defineProps<DialogRootProps>();
</script>

<template>
  <DialogRoot v-bind="props">
    <slot />
  </DialogRoot>
</template>
