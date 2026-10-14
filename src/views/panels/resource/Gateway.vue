<script setup lang="ts">
import { Route, Router } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { groupOf } from "@/lib/operators/format";
import {
  attachedRoutes,
  GATEWAY_GROUP,
  gatewayAddresses,
  gatewayListeners,
  gatewayState,
  routesOfGateway,
} from "@/lib/operators/gatewayApi";
import { targetOf } from "@/lib/operators/panel";

/* Gateway API Gateways (Istio's networking.istio.io Gateway: nothing). */
const props = defineProps<{ resource: any }>();

const isGatewayApi = computed(() => groupOf(props.resource?.apiVersion) === GATEWAY_GROUP);
const target = computed(() => targetOf(props.resource));
const listeners = computed(() => gatewayListeners(props.resource));
const addresses = computed(() => gatewayAddresses(props.resource));

const line = computed(() => {
  const count = attachedRoutes(props.resource);
  return [
    props.resource?.spec?.gatewayClassName && `Class ${props.resource.spec.gatewayClassName}`,
    props.resource?.status?.listeners && `${count} route${count === 1 ? "" : "s"} attached`,
  ]
    .filter(Boolean)
    .join(" · ");
});

/* Routes anywhere in the cluster that name this gateway as their parent. */
const routes = shallowRef<ReturnType<typeof routesOfGateway> | null>(null);
const routesError = ref("");
onMounted(async () => {
  if (!isGatewayApi.value) return;
  const list = (resource: string) =>
    kubeGet(target.value, apiPath({ apiVersion: `${GATEWAY_GROUP}/v1`, resource }))
      .then((response) => (response?.items ?? []) as any[])
      .catch(() => [] as any[]);
  try {
    const [http, grpc] = await Promise.all([list("httproutes"), list("grpcroutes")]);
    routes.value = routesOfGateway(props.resource, [
      ...http.map((r) => ({ apiVersion: `${GATEWAY_GROUP}/v1`, kind: "HTTPRoute", ...r })),
      ...grpc.map((r) => ({ apiVersion: `${GATEWAY_GROUP}/v1`, kind: "GRPCRoute", ...r })),
    ]);
  } catch (error) {
    routesError.value = (error as { message?: string })?.message ?? String(error);
  }
});

const routeLabel = (route: any) =>
  route.metadata?.namespace !== props.resource.metadata?.namespace
    ? `${route.metadata?.namespace}/${route.metadata?.name}`
    : route.metadata?.name;
</script>

<template>
  <template v-if="isGatewayApi">
    <StatusHeader :state="gatewayState(resource)" :line="line" />

    <PanelSection value="spec" title="Listeners" :icon="Router" :count="listeners.length">
      <ul class="divide-y divide-border-subtle text-xs">
        <li v-for="listener in listeners" :key="listener.name" class="py-2 first:pt-0 last:pb-0">
          <div class="flex items-baseline justify-between gap-3">
            <span class="flex min-w-0 items-baseline gap-2">
              <span class="shrink-0 font-medium">{{ listener.endpoint }}</span>
              <span class="truncate text-muted-foreground">{{ listener.hostname ?? "any hostname" }}</span>
            </span>
            <span v-if="listener.attachedRoutes !== undefined" class="shrink-0 tabular-nums text-muted-foreground">
              {{ listener.attachedRoutes }} route{{ listener.attachedRoutes === 1 ? "" : "s" }}
            </span>
          </div>
          <p v-if="listener.tls" class="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
            TLS from
            <ObjectLink
              :target="target"
              :object="{ apiVersion: 'v1', kind: 'Secret', name: listener.tls, namespace: resource.metadata?.namespace }"
            />
          </p>
          <p v-if="listener.problem" class="mt-0.5 text-warning">{{ listener.problem }}</p>
        </li>
      </ul>
      <Fields v-if="addresses.length" class="mt-3 border-t border-border-subtle pt-3">
        <Field label="Address" :value="addresses.join(', ')" mono />
      </Fields>
    </PanelSection>

    <PanelSection value="flow" title="Routes" :icon="Route" :count="routes?.length">
      <p v-if="routesError" class="text-xs text-muted-foreground">Couldn't load the routes: {{ routesError }}</p>
      <div v-else-if="!routes" class="space-y-2" aria-label="Loading the routes">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
      </div>
      <p v-else-if="routes.length === 0" class="text-xs text-muted-foreground">
        No routes use this gateway yet.
      </p>
      <ul v-else class="space-y-2 text-xs">
        <li v-for="{ route, parent } in routes" :key="route.metadata?.uid" class="flex items-start gap-2.5">
          <StatusDot :tone="parent.state.tone" class="mt-1" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <ObjectLink
                :target="target"
                :object="{ apiVersion: route.apiVersion, kind: route.kind, name: route.metadata?.name, namespace: route.metadata?.namespace }"
                :label="routeLabel(route)"
              />
              <span
                class="shrink-0"
                :class="parent.state.tone === 'success' ? 'text-muted-foreground' : statusTextClass[parent.state.tone]"
                >{{ parent.state.label }}</span
              >
            </div>
            <p class="truncate text-muted-foreground">
              {{ (route.spec?.hostnames ?? []).join(", ") || "Any hostname" }}
            </p>
          </div>
        </li>
      </ul>
    </PanelSection>
  </template>
</template>
