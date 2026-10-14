<script setup lang="ts">
/** Side panel of a Gateway API HTTPRoute / GRPCRoute: parents, then the rules. */
import { Router, Workflow } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import StatusHeader from "./StatusHeader.vue";
import ObjectLink from "./ObjectLink.vue";
import RouteRules from "./RouteRules.vue";
import { groupOf, humanize } from "@/lib/operators/format";
import { GATEWAY_GROUP, routeParents, routeState } from "@/lib/operators/gatewayApi";
import { targetOf } from "@/lib/operators/panel";

const props = defineProps<{ resource: any }>();

const isGatewayApi = computed(() => groupOf(props.resource?.apiVersion) === GATEWAY_GROUP);
const parents = computed(() => routeParents(props.resource));
const line = computed(() => {
  const hostnames: string[] = props.resource?.spec?.hostnames ?? [];
  return hostnames.length ? hostnames.join(", ") : "Any hostname";
});

const gatewayRef = (parent: { name: string; namespace?: string; kind: string }) => ({
  apiVersion: `${GATEWAY_GROUP}/v1`,
  kind: parent.kind,
  name: parent.name,
  namespace: parent.namespace,
});
</script>

<template>
  <template v-if="isGatewayApi">
    <StatusHeader :state="routeState(resource)" :line="line" />

    <PanelSection value="spec" title="Gateways" :icon="Router" :count="parents.length">
      <ul class="space-y-2.5 text-xs">
        <li v-for="parent in parents" :key="parent.label" class="flex items-start gap-2.5">
          <StatusDot :tone="parent.state.tone" class="mt-1" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <ObjectLink
                v-if="parent.kind === 'Gateway'"
                :target="targetOf(resource)"
                :object="gatewayRef(parent)"
                :label="parent.label"
              />
              <span v-else class="truncate">{{ parent.label }} ({{ parent.kind }})</span>
              <span
                class="shrink-0"
                :class="parent.state.tone === 'success' ? 'text-muted-foreground' : statusTextClass[parent.state.tone]"
                >{{ parent.state.label }}</span
              >
            </div>
            <p v-if="parent.state.reason || parent.state.message" class="mt-0.5 select-text text-muted-foreground">
              <span v-if="parent.state.reason" class="font-medium text-foreground/80">{{ humanize(parent.state.reason) }}</span>
              <template v-if="parent.state.reason && parent.state.message"> · </template>{{ parent.state.message }}
            </p>
          </div>
        </li>
      </ul>
    </PanelSection>

    <PanelSection value="flow" title="Rules" :icon="Workflow" :count="resource.spec?.rules?.length ?? 0">
      <RouteRules :route="resource" />
    </PanelSection>
  </template>
</template>
