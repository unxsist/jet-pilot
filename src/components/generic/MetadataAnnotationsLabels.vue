<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import Button from "../ui/button/Button.vue";

const props = defineProps<{
  type: "annotations" | "labels";
  object: KubernetesObject;
}>();

/* Collapsed lists show this many entries. */
const PREVIEW_COUNT = 4;

const showAll = ref(false);

const source = computed(() => {
  return props.type === "annotations"
    ? props.object.metadata?.annotations
    : props.object.metadata?.labels;
});

const total = computed(() => Object.keys(source.value || {}).length);

const data = computed(() => {
  return showAll.value
    ? source.value
    : Object.fromEntries(
        Object.entries(source.value || {}).slice(0, PREVIEW_COUNT)
      );
});
</script>

<template>
  <!-- Labels: compact key=value chips -->
  <div v-if="type === 'labels'" class="flex flex-wrap gap-1.5">
    <span
      v-for="(value, key) in data"
      :key="key"
      class="inline-flex h-6 max-w-full items-center overflow-hidden rounded-md border bg-surface-1 px-2 font-mono text-xs select-text"
      :title="`${key}=${value}`"
    >
      <span class="truncate text-muted-foreground">{{ key }}</span>
      <span class="text-muted-foreground/60">=</span>
      <span class="truncate text-foreground">{{ value }}</span>
    </span>
    <Button
      v-if="total > PREVIEW_COUNT"
      size="xs"
      variant="ghost"
      class="text-muted-foreground"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show less" : `+${total - PREVIEW_COUNT} more` }}
    </Button>
  </div>

  <!-- Annotations: values can be long (JSON, URLs): description list -->
  <div v-else>
    <dl class="divide-y divide-border-subtle">
      <div
        v-for="(value, key) in data"
        :key="key"
        class="py-1.5 first:pt-0 last:pb-0"
      >
        <dt class="truncate font-mono text-xs text-muted-foreground" :title="key">
          {{ key }}
        </dt>
        <dd
          class="line-clamp-3 break-all font-mono text-xs text-foreground select-text"
          :title="value"
        >
          {{ value }}
        </dd>
      </div>
    </dl>
    <Button
      v-if="total > PREVIEW_COUNT"
      size="xs"
      variant="ghost"
      class="mt-1 -ml-2 text-muted-foreground"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show less" : `+${total - PREVIEW_COUNT} more` }}
    </Button>
  </div>

  <span v-if="total === 0" class="text-xs text-muted-foreground"
    >No {{ type }}</span
  >
</template>
