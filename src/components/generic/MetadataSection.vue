<script setup lang="ts">
/**
 * The Labels or Annotations section of a side panel, with Edit in its
 * heading (blocked with a toast on read-only clusters).
 */
import type { KubernetesObject } from "@kubernetes/client-node";
import { NotebookPen, Pencil, Tags } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import PanelSection from "@/components/generic/PanelSection.vue";
import MetadataAnnotationsLabels from "@/components/generic/MetadataAnnotationsLabels.vue";
import { PanelSectionsKey } from "@/components/generic/panelSections";
import { allowed, rowTargets } from "@/lib/guardrails/guard";

const props = defineProps<{
  type: "labels" | "annotations";
  object: KubernetesObject;
  editable?: boolean;
}>();

const sections = inject(PanelSectionsKey, null);
const editing = ref(false);
const value = computed(() => props.type);
const count = computed(
  () => Object.keys((props.type === "labels" ? props.object.metadata?.labels : props.object.metadata?.annotations) ?? {}).length
);

const edit = () => {
  if (!allowed(props.type === "labels" ? "edit-labels" : "edit-annotations", rowTargets([props.object]))) return;
  sections?.open(value.value);
  editing.value = true;
};

/* Another object in the panel: leave edit mode. */
watch(
  () => props.object.metadata?.uid,
  () => (editing.value = false)
);
</script>

<template>
  <PanelSection
    :value="value"
    :title="type === 'labels' ? 'Labels' : 'Annotations'"
    :icon="type === 'labels' ? Tags : NotebookPen"
    :count="count"
  >
    <template v-if="editable !== false && !editing" #actions>
      <Button
        variant="ghost"
        size="xs"
        class="h-6 text-muted-foreground"
        :aria-label="`Edit ${type}`"
        @click="edit"
      >
        <Pencil class="h-3 w-3" /> Edit
      </Button>
    </template>
    <MetadataAnnotationsLabels v-model:editing="editing" :type="type" :object="object" />
  </PanelSection>
</template>
