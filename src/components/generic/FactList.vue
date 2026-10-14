<script setup lang="ts">
/**
 * A spec sheet: quiet labels on the left, values on the right, one fact per
 * line. Fill it with <Fact>s.
 */
</script>

<template>
  <dl class="grid grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2">
    <slot />
  </dl>
</template>
