<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import Badge from "../ui/badge/Badge.vue";
import Button from "../ui/button/Button.vue";

const props = defineProps<{
  type: "annotations" | "labels";
  object: KubernetesObject;
}>();

const showAll = ref(false);

const source = computed(() => {
  return props.type === "annotations"
    ? props.object.metadata?.annotations
    : props.object.metadata?.labels;
});

const data = computed(() => {
  return showAll.value
    ? source.value
    : Object.fromEntries(Object.entries(source.value || {}).slice(0, 2));
});
</script>

<template>
  <div class="flex flex-wrap gap-2 font-mono">
    <Badge v-for="(value, key) in data" :key="key" variant="outline">
      <span class="mr-1">{{ key }}:</span
      ><span class="font-normal text-muted-foreground">
        {{ value }}
      </span></Badge
    >
    <Button
      size="xs"
      variant="link"
      v-if="Object.keys(source || {}).length > 2"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show less" : "Show more" }}
    </Button>
    <span
      v-if="Object.keys(source || {}).length === 0"
      class="text-xs text-muted-foreground"
      >No {{ type }}</span
    >
  </div>
</template>
