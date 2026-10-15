<script setup lang="ts">
/*
 * Custom actions in the side panel's header row, next to Edit YAML /
 * Describe / Logs: the ones whose scope matches the object. As many show
 * as buttons as fit in the rest of the row (measured, so the header never
 * wraps); the others go into a "⋯" menu at its end.
 */
import { useResizeObserver } from "@vueuse/core";
import { MoreHorizontal } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCustomActions } from "@/lib/customActions/store";
import { actionIconComponent } from "@/lib/customActions/icons";
import { matchesScope } from "@/lib/customActions/scope";
import { runCustom } from "@/lib/customActions/rowActions";
import { customActionKind } from "@/lib/customActions/plan";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { isBlocked } from "@/lib/guardrails/policy";
import type { CustomAction } from "@/lib/customActions/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { injectStrict } from "@/lib/utils";

const props = defineProps<{
  resource: Record<string, any>;
  context: string;
  kubeConfig: string;
}>();

const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { actions } = useCustomActions();

const matching = computed(() => {
  const cluster = guardedCluster(props.context, props.kubeConfig);
  return actions.value.filter(
    (action) =>
      matchesScope(action, props.resource, props.context) &&
      // Read-only clusters: actions that would change them are left out.
      !isBlocked(customActionKind(action), cluster)
  );
});

/*
 * How many buttons fit: the room left in the row, against the widths of
 * the buttons (rendered once, invisibly, to measure them).
 */
const GAP = 6;
const MORE = 26;
const root = ref<HTMLElement | null>(null);
const measure = ref<HTMLElement | null>(null);
const room = ref(0);
const widths = ref<number[]>([]);
useResizeObserver(root, (entries) => (room.value = entries[0]?.contentRect.width ?? 0));
useResizeObserver(measure, () => {
  widths.value = Array.from(measure.value?.children ?? [], (el) => (el as HTMLElement).offsetWidth);
});
const fitting = computed(() => {
  const all = matching.value.length;
  const total = widths.value.reduce((sum, w) => sum + w + GAP, 0);
  if (widths.value.length === all && total <= room.value) return all;
  let used = MORE + GAP;
  let count = 0;
  for (const width of widths.value) {
    if (used + width + GAP > room.value) break;
    used += width + GAP;
    count++;
  }
  return count;
});
const inline = computed(() => matching.value.slice(0, fitting.value));
const overflow = computed(() => matching.value.slice(fitting.value));

const run = (action: CustomAction) => {
  const object = {
    ...props.resource,
    metadata: { ...props.resource.metadata, context: props.context, kubeConfig: props.kubeConfig },
  };
  void runCustom(action, [object], {
    addTab,
    spawnDialog,
    primary: { context: props.context, kubeConfig: props.kubeConfig },
  });
};
</script>

<template>
  <div v-if="matching.length" ref="root" class="relative flex min-w-0 flex-1 items-center gap-1.5">
    <!-- Every button once, invisible: their widths decide how many fit. -->
    <div class="pointer-events-none invisible absolute h-0 w-0 overflow-hidden" aria-hidden="true">
      <div ref="measure" class="flex w-max gap-1.5">
        <Button v-for="action in matching" :key="action.id" variant="outline" size="xs" tabindex="-1">
          <component :is="actionIconComponent(action.icon)" class="h-3 w-3" />
          {{ action.name }}
        </Button>
      </div>
    </div>
    <Button
      v-for="action in inline"
      :key="action.id"
      variant="outline"
      size="xs"
      :title="action.description || undefined"
      @click="run(action)"
    >
      <component :is="actionIconComponent(action.icon)" class="h-3 w-3" />
      {{ action.name }}
    </Button>
    <DropdownMenu v-if="overflow.length">
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="xs" class="w-[26px] px-0" :aria-label="`${overflow.length} more actions`">
          <MoreHorizontal class="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-[12rem]">
        <DropdownMenuLabel>Custom</DropdownMenuLabel>
        <DropdownMenuItem v-for="action in overflow" :key="action.id" @select="run(action)">
          <component :is="actionIconComponent(action.icon)" class="h-3.5 w-3.5 text-muted-foreground" />
          {{ action.name }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
