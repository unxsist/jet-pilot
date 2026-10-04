<script setup lang="ts">
defineProps<{
  text: string;
  value: number;
  threshold?: number;
}>();
</script>
<template>
  <div>
    <div class="flex items-center space-x-2 text-xxs">
      <span class="w-[10px] text-center leading-none text-muted-foreground">{{
        text
      }}</span>
      <div class="relative h-[5px] w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-[5px] w-0 rounded-full transition-[width] duration-300 ease-out"
          :class="
            value >= 90
              ? 'bg-destructive'
              : value >= 70
              ? 'bg-warning'
              : 'bg-success'
          "
          :style="{ width: `${value}%` }"
        ></div>
        <div
          v-if="threshold"
          class="absolute top-0 h-[5px] w-px bg-foreground opacity-50"
          :style="{ left: `${threshold}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>
