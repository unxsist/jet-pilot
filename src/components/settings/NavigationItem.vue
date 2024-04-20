<script setup lang="ts">
import { useRoute, RouteLocationRaw } from "vue-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const $route = useRoute();

const props = defineProps<{
  title: string;
  to: RouteLocationRaw;
}>();
</script>
<template>
  <router-link :to="props.to" v-slot="{ isActive }">
    <Button
      :class="
        cn(
          'w-full text-left justify-start',
          !isActive &&
            'bg-background text-foreground hover:bg-muted shadow-none'
        )
      "
    >
      <span>{{ title }}</span>
    </Button>
  </router-link>
</template>
