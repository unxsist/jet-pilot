<script setup lang="ts">
/**
 * Bindings to roles that don't exist, as one quiet line that opens to the
 * list: harmless today, but they grant again the moment someone creates a
 * role with that name.
 */
import { ChevronRight } from "lucide-vue-next";
import ObjectLink from "./ObjectLink.vue";
import { useRbacLinks } from "./useRbacLinks";
import type { BindingObject } from "@/lib/rbac";

const props = defineProps<{ bindings: BindingObject[] }>();
const { openObject } = useRbacLinks();
const open = ref(false);
const count = computed(() => props.bindings.length);
</script>

<template>
  <div class="text-xs">
    <button
      type="button"
      class="flex items-center gap-2 rounded text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
      {{ count }} {{ count === 1 ? "binding refers to a role that doesn't exist" : "bindings refer to roles that don't exist" }}
      <ChevronRight class="h-3 w-3 transition-transform duration-fast" :class="open && 'rotate-90'" />
    </button>
    <div v-if="open" class="mt-2 space-y-2 pl-4">
      <p class="text-muted-foreground">
        They grant nothing until someone creates a role with that name. Remove them, or create the
        role on purpose.
      </p>
      <ul class="space-y-1">
        <li v-for="binding in bindings" :key="binding.metadata.uid ?? binding.metadata.name" class="flex flex-wrap items-center gap-1.5">
          <ObjectLink :kind="binding.kind" :name="binding.metadata.name" :object="binding" @open="openObject(binding)" />
          <span v-if="binding.metadata.namespace" class="text-muted-foreground">in {{ binding.metadata.namespace }}</span>
          <ChevronRight class="h-3 w-3 text-muted-foreground/60" aria-hidden="true" />
          <ObjectLink :kind="binding.roleRef.kind" :name="binding.roleRef.name" missing />
        </li>
      </ul>
    </div>
  </div>
</template>
