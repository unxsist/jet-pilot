<script setup lang="ts">
/**
 * A related object (a route's Service, a certificate's Secret) as a link:
 * opens that object's side panel.
 */
import KindIcon from "@/components/KindIcon.vue";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { openObjectPanel, type ObjectRef } from "@/lib/operators/panel";
import type { KubeTarget } from "@/lib/kubeApi";

const props = defineProps<{
  target: KubeTarget;
  object: ObjectRef;
  /** Defaults to the object's name. */
  label?: string;
}>();

const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);
const opening = ref(false);

const open = async () => {
  opening.value = true;
  try {
    await openObjectPanel(setSidePanelComponent, props.target, props.object);
  } finally {
    opening.value = false;
  }
};
</script>

<template>
  <button
    type="button"
    class="group/link inline-flex max-w-full items-center gap-1.5 rounded-sm text-left text-foreground transition-colors duration-fast hover:text-link focus-ring focus-visible:ring-offset-card"
    :class="{ 'opacity-60': opening }"
    :title="`Open ${object.kind} ${object.name}`"
    @click="open"
  >
    <KindIcon
      :name="formatResourceKind(object.kind).toLowerCase()"
      class="h-3.5 w-3.5 text-muted-foreground transition-colors duration-fast group-hover/link:text-link"
    />
    <span class="truncate decoration-link underline-offset-[3px] group-hover/link:underline">{{
      label ?? object.name
    }}</span>
  </button>
</template>
