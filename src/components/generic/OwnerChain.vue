<script setup lang="ts">
/**
 * Who controls an object, from the top down (Deployment, then its
 * ReplicaSet), each a link. The direct owner shows right away; the levels
 * above are fetched once per object.
 */
import { CornerDownRight } from "lucide-vue-next";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import { fetchRef, type PanelTarget } from "@/lib/resources/open";
import { ownerOf, resolveOwners } from "@/lib/resources/pod";
import type { ObjectRef } from "@/lib/resources/kinds";

const props = defineProps<{ object: any; target: PanelTarget }>();

const chain = ref<ObjectRef[]>([]);
watch(
  () => `${props.target.context}/${props.object.metadata?.uid}`,
  async (key) => {
    const direct = ownerOf(props.object);
    chain.value = direct ? [direct] : [];
    if (!direct) return;
    const resolved = await resolveOwners(props.object, (owner) => fetchRef(props.target, owner));
    if (key === `${props.target.context}/${props.object.metadata?.uid}`) chain.value = resolved;
  },
  { immediate: true }
);

const fromTop = computed(() => [...chain.value].reverse());
</script>

<template>
  <ul v-if="fromTop.length" class="space-y-0.5">
    <li
      v-for="(owner, index) in fromTop"
      :key="`${owner.kind}/${owner.name}`"
      class="flex min-w-0 items-baseline gap-1.5"
      :style="{ paddingLeft: `${Math.max(0, index - 1) * 0.875}rem` }"
    >
      <CornerDownRight v-if="index > 0" class="h-3 w-3 shrink-0 translate-y-[1px] text-muted-foreground/70" aria-hidden="true" />
      <span class="shrink-0 text-xs text-muted-foreground">{{ owner.kind }}</span>
      <ObjectLink :object-ref="owner" :target="target" />
    </li>
  </ul>
  <span v-else class="text-muted-foreground">None</span>
</template>
