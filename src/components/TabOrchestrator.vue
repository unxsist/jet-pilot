<script setup lang="ts">
import Expand from "@/assets/icons/expand.svg";

const state = reactive({
  open: false,
});
</script>
<template>
  <div class="border-t border-l bg-background">
    <div class="flex items-center mb-0 text-xs py-1 px-1">
      <div class="flex space-x-3">
        <div
          class="py-1 px-2 rounded cursor-pointer max-w-[200px] truncate hover:bg-border"
        >
          Logs for minikube/default/countdown-b8dz2
        </div>
        <div class="py-1 px-2 rounded cursor-pointer hover:bg-border">
          Tab 2
        </div>
        <div class="py-1 px-2 rounded cursor-pointer hover:bg-border">
          Tab 3
        </div>
      </div>
      <div
        class="ml-auto p-1 rounded cursor-pointer hover:bg-border"
        @click="state.open = !state.open"
      >
        <Expand
          class="text-white h-3"
          :class="{ 'rotate-90': !state.open, 'rotate-270': state.open }"
        />
      </div>
    </div>
    <div class="" v-show="state.open">Test</div>
  </div>
</template>
