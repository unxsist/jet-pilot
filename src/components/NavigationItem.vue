<script setup lang="ts">
import NavigationItemIcon from "@/components/NavigationItemIcon.vue";
import { RouteLocationRaw, useRouter } from "vue-router";

const router = useRouter();
const active = computed(() => {
  return router.currentRoute.value.name === props.to.name;
});

const props = defineProps<{
  icon: string;
  title: string;
  to: RouteLocationRaw;
}>();
</script>
<template>
  <div
    :class="{
      'bg-background border text-primary': active,
      'border border-transparent': !active,
    }"
    class="flex items-center font-semibold rounded-l-lg border-r-0 px-2 py-1 text-[#7a7a7a] cursor-pointer transition-all hover:bg-background hover:text-primary"
    @click="router.push(props.to)"
  >
    <NavigationItemIcon :name="props.icon" />
    <span class="mx-3 truncate" :title="title">{{ title }}</span>
  </div>
</template>
