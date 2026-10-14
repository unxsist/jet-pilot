<script setup lang="ts">
/*
 * Custom actions in the side panel's header row, next to Edit YAML /
 * Describe / Logs: the ones whose scope matches the object. A few show as
 * buttons, more go into an overflow menu so the header stays calm.
 */
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

/* Inline buttons; with more actions, one fewer plus the menu. */
const INLINE = 3;

const matching = computed(() => {
  const cluster = guardedCluster(props.context, props.kubeConfig);
  return actions.value.filter(
    (action) =>
      matchesScope(action, props.resource, props.context) &&
      // Read-only clusters: actions that would change them are left out.
      !isBlocked(customActionKind(action), cluster)
  );
});
const inline = computed(() =>
  matching.value.length <= INLINE ? matching.value : matching.value.slice(0, INLINE - 1)
);
const overflow = computed(() => (matching.value.length <= INLINE ? [] : matching.value.slice(INLINE - 1)));

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
  <template v-if="matching.length">
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
        <Button variant="outline" size="xs" :aria-label="`${overflow.length} more actions`">
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
  </template>
</template>
