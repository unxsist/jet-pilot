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
      <span class="w-[10px] text-center leading-none">{{ text }}</span>
      <div class="relative w-full h-[5px] bg-gray-800">
        <div
          class="w-0 h-[5px] bg-green-500"
          :class="{
            'bg-red-500': value >= 90,
            'bg-yellow-500': value >= 70 && value < 90,
          }"
          :style="{ width: `${value}%` }"
        ></div>
        <div
          v-if="threshold"
          class="absolute top-0 w-[1px] h-[5px] bg-white opacity-50"
          :style="{ left: `${threshold}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>
