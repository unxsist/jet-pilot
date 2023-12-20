<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
  }>(),
  {
    label: "Loading...",
  }
);
</script>
<template>
  <div class="flex flex-col w-full items-center justify-center h-full">
    <svg
      class="animate-spin h-[50px] w-[50px] text-primary"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      ></circle>
      <path
        class=""
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      ></path>
    </svg>
    <span class="block mt-5 opacity-75">{{ label }}</span>
  </div>
</template>
