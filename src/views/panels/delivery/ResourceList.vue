<script setup lang="ts">
/**
 * What a delivery put in the cluster, grouped by kind, problems first. A
 * dot per resource (health / sync), a word only when it needs one; a click
 * opens the resource's list with the resource highlighted.
 */
import { useRouter } from "vue-router";
import { ChevronRight } from "lucide-vue-next";
import KindIcon from "@/components/KindIcon.vue";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { formatResourceKind } from "@/lib/utils";
import { groupResources, type DeliveredResource } from "@/lib/gitops/model";
import { openDeliveredResource } from "@/lib/gitops/ui";

const props = defineProps<{
  resources: DeliveredResource[];
  context: string;
  kubeConfig: string;
}>();

const router = useRouter();
const groups = computed(() => groupResources(props.resources));

/* The namespace most resources live in goes without saying; others are named. */
const commonNamespace = computed(() => {
  const counts = new Map<string, number>();
  for (const r of props.resources) if (r.namespace) counts.set(r.namespace, (counts.get(r.namespace) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
});

/* Long groups show their first items (problems are sorted first). */
const LIMIT = 6;
const expanded = reactive(new Set<string>());
const shown = (kind: string, items: DeliveredResource[]) =>
  expanded.has(kind) ? items : items.slice(0, LIMIT);

const opening = ref<string | null>(null);
const open = async (resource: DeliveredResource) => {
  opening.value = resource.key;
  try {
    await openDeliveredResource(router, { context: props.context, kubeConfig: props.kubeConfig }, resource);
  } finally {
    opening.value = null;
  }
};
</script>

<template>
  <div class="space-y-3">
    <div v-for="group in groups" :key="group.kind">
      <div class="mb-0.5 flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
        <KindIcon :name="formatResourceKind(group.kind).toLowerCase()" class="h-3.5 w-3.5" />
        <span class="font-medium text-foreground/80">{{ group.kind }}</span>
        <span class="tabular-nums">{{ group.items.length }}</span>
      </div>
      <ul>
        <li v-for="item in shown(group.kind, group.items)" :key="item.key">
          <button
            type="button"
            class="group/item flex h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/60 focus-ring disabled:opacity-60"
            :title="item.message ?? `Open ${group.kind} ${item.name}`"
            :disabled="opening === item.key"
            @click="open(item)"
          >
            <StatusDot :tone="item.tone" size="sm" class="ml-[5px]" :label="item.note ?? item.health ?? item.sync" />
            <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
            <span v-if="item.note" class="shrink-0 text-xs" :class="statusTextClass[item.tone]">{{ item.note }}</span>
            <span
              v-else-if="item.namespace && item.namespace !== commonNamespace"
              class="shrink-0 truncate text-xs text-muted-foreground"
              >{{ item.namespace }}</span
            >
            <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/item:opacity-100" />
          </button>
        </li>
      </ul>
      <button
        v-if="group.items.length > LIMIT && !expanded.has(group.kind)"
        type="button"
        class="ml-1.5 mt-0.5 text-xs text-link hover:underline"
        @click="expanded.add(group.kind)"
      >
        Show all {{ group.items.length }}
      </button>
    </div>
  </div>
</template>
