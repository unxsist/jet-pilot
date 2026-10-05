<script setup lang="ts">
import { X } from "lucide-vue-next";
import { StatusDot } from "@/components/ui/status";

/* Edge types and health colours of the resource graph (one compact row). */
defineEmits<{ (e: "close"): void }>();

const EDGES = [
  { classes: "graph-edge--routes", label: "Traffic" },
  { classes: "graph-edge--owns", label: "Owns" },
  { classes: "graph-edge--mounts", label: "Uses" },
  { classes: "graph-edge--selects", label: "Selects" },
  { classes: "graph-edge--scales", label: "Scales" },
  { classes: "graph-edge--mounts graph-edge--missing", label: "Missing" },
];
</script>

<template>
  <div
    class="flex h-8 items-center gap-3 rounded-lg border bg-popover pl-3 pr-1 text-xs text-muted-foreground shadow-md"
    role="region"
    aria-label="Legend"
  >
    <span
      v-for="edge in EDGES"
      :key="edge.label"
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <svg width="20" height="6" class="shrink-0" aria-hidden="true">
        <path
          d="M1 3 H19"
          :class="['graph-edge', 'graph-edge--legend', edge.classes]"
        />
      </svg>
      {{ edge.label }}
    </span>
    <span class="h-4 w-px bg-border" aria-hidden="true" />
    <span class="inline-flex items-center gap-1"
      ><StatusDot tone="success" size="sm" />ok</span
    >
    <span class="inline-flex items-center gap-1"
      ><StatusDot tone="warning" size="sm" />degraded</span
    >
    <span class="inline-flex items-center gap-1"
      ><StatusDot tone="destructive" size="sm" />failing</span
    >
    <button
      type="button"
      class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Hide legend"
      title="Hide legend"
      @click="$emit('close')"
    >
      <X class="h-3 w-3" />
    </button>
  </div>
</template>
