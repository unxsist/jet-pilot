<script setup lang="ts">
/**
 * One rule of the Risks tab: what's wrong and how many ("7 workloads have
 * no memory limit") with why it matters, one quiet line. Expanding it shows
 * how to fix it and the objects, each a click away from its side panel;
 * safe fixes (renew a certificate, add a disruption budget) show over the
 * row's detail on hover, so details line up.
 */
import { ChevronRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { kindIcon } from "@/lib/kindIcons";
import { formatResourceKind } from "@/lib/utils";
import type { RiskGroup, RiskItem } from "@/lib/health/checks/rules";

const props = defineProps<{
  group: RiskGroup;
  expanded: boolean;
  /** Several clusters are checked: say which one an object is in. */
  clusterOf?: (item: RiskItem) => string;
}>();
const emit = defineEmits<{ toggle: []; open: [item: RiskItem]; act: [item: RiskItem] }>();

const LIMIT = 8;
const showAll = ref(false);
const visible = computed(() => (showAll.value ? props.group.items : props.group.items.slice(0, LIMIT)));

const ACTIONS: Record<NonNullable<RiskItem["action"]>, string> = { renew: "Renew", "add-pdb": "Add budget" };

const where = (item: RiskItem) =>
  [item.object.namespace, props.clusterOf?.(item)].filter(Boolean).join(" · ");
const opens = (item: RiskItem) => item.object.kind !== "Context";
const detailClass = (item: RiskItem) =>
  item.tone === "destructive" || item.tone === "warning" ? statusTextClass[item.tone] : "text-muted-foreground";
</script>

<template>
  <div class="rounded-lg transition-colors duration-fast" :class="expanded && 'bg-muted/40'">
    <button
      type="button"
      class="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-fast ease-out hover:bg-accent/50 focus-ring"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <span class="flex h-5 w-3 shrink-0 items-center justify-center">
        <StatusDot :tone="group.tone" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-medium text-foreground">{{ group.rule.title(group.items.length) }}</span>
        <span class="block text-xs text-muted-foreground">{{ group.rule.why }}</span>
      </span>
      <ChevronRight
        class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/80 transition-transform duration-fast"
        :class="expanded && 'rotate-90'"
      />
    </button>

    <div v-if="expanded" class="pb-3 pl-9 pr-3 pt-1">
      <p class="mb-2 text-xs text-muted-foreground"><span class="font-medium text-foreground/80">How to fix</span> · {{ group.rule.fix }}</p>
      <ul class="space-y-px">
        <li
          v-for="item in visible"
          :key="`${item.context}/${item.object.kind}/${item.object.namespace}/${item.object.name}`"
          class="group/row relative -mx-2 flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2 transition-colors duration-fast"
          :class="opens(item) ? 'cursor-pointer hover:bg-accent/50' : ''"
          :tabindex="opens(item) ? 0 : undefined"
          :role="opens(item) ? 'button' : undefined"
          :title="opens(item) ? `Open ${item.object.kind} ${item.object.name}` : undefined"
          @click="opens(item) && emit('open', item)"
          @keydown.enter="opens(item) && emit('open', item)"
        >
          <component
            :is="kindIcon(item.object.kind === 'Context' ? 'secrets' : formatResourceKind(item.object.kind).toLowerCase())"
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            :aria-label="item.object.kind"
          />
          <span class="truncate text-sm text-foreground">{{ item.object.kind === "Context" ? "Kubeconfig credential" : item.object.name }}</span>
          <span v-if="where(item)" class="shrink-0 text-xs text-muted-foreground">{{ where(item) }}</span>
          <span class="ml-auto min-w-0 truncate text-right text-xs" :class="detailClass(item)" :title="[item.detail, item.code].filter(Boolean).join(' · ')">
            {{ item.detail }}<template v-if="item.detail && item.code"> · </template><span v-if="item.code" class="font-mono">{{ item.code }}</span>
          </span>
          <Button
            v-if="item.action"
            size="sm"
            variant="outline"
            class="absolute right-2 top-1/2 h-7 -translate-y-1/2 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100"
            @click.stop="emit('act', item)"
            @keydown.enter.stop
          >
            {{ ACTIONS[item.action] }}
          </Button>
        </li>
      </ul>
      <button
        v-if="group.items.length > LIMIT"
        type="button"
        class="mt-1 rounded text-xs text-link hover:underline focus-ring"
        @click="showAll = !showAll"
      >
        {{ showAll ? "Show fewer" : `Show all ${group.items.length}` }}
      </button>
    </div>
  </div>
</template>
