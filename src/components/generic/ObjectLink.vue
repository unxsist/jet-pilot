<script setup lang="ts">
/**
 * A reference to another object (an owner, a node, a claim) that opens it
 * in the side panel, with Back to return. `object` skips the fetch when
 * the caller already has it (e.g. from a watched list). Inline by default;
 * `kind` shows the kind's icon in front.
 */
import KindIcon from "@/components/KindIcon.vue";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import {
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { followRef, openInPanel, type PanelTarget } from "@/lib/resources/open";
import type { ObjectRef } from "@/lib/resources/kinds";

const props = defineProps<{
  objectRef: ObjectRef;
  target: PanelTarget;
  object?: unknown;
  label?: string;
  icon?: boolean;
}>();

const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const opening = ref(false);
const open = async () => {
  if (props.object) {
    openInPanel(setSidePanel, sidePanel.value, props.object);
    return;
  }
  opening.value = true;
  try {
    await followRef(setSidePanel, sidePanel.value, props.target, props.objectRef);
  } finally {
    opening.value = false;
  }
};
</script>

<template>
  <button
    type="button"
    class="inline-flex min-w-0 max-w-full items-baseline gap-1.5 rounded-sm text-left text-link decoration-link/40 underline-offset-[3px] transition-opacity duration-fast hover:underline focus-ring focus-visible:ring-offset-card"
    :class="opening ? 'opacity-60' : ''"
    :title="`Open ${objectRef.kind} ${objectRef.name}`"
    :aria-busy="opening"
    @click="open"
  >
    <KindIcon
      v-if="icon"
      :name="formatResourceKind(objectRef.kind).toLowerCase()"
      class="h-3.5 w-3.5 translate-y-[2px] self-start text-muted-foreground"
    />
    <span class="min-w-0 truncate"><slot>{{ label ?? objectRef.name }}</slot></span>
  </button>
</template>
