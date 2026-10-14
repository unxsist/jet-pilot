<script setup lang="ts">
/**
 * A Service: how it is reached (type, IPs, load balancer), its ports (a
 * port forward one click away), the pods behind it (ready or not, from its
 * EndpointSlices) and the Ingresses / HTTPRoutes that send traffic to it.
 */
import { Cable, Info, Route, Split, Waypoints } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import PodList from "@/components/generic/PodList.vue";
import { useNow, usePanelTarget, useRelatedList, useServed } from "@/composables/usePanelObject";
import { injectStrict } from "@/lib/utils";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { plural } from "@/lib/resources/format";
import { httpRoutesFor, ingressesFor, portMapping, serviceEndpoints } from "@/lib/resources/network";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const spec = computed(() => props.resource.spec ?? {});
const namespace = computed(() => props.resource.metadata?.namespace as string);
const ns = () => (namespace.value ? [namespace.value] : null);

const TYPE_WORDS: Record<string, string> = {
  ClusterIP: "reachable inside the cluster",
  NodePort: "also on a port of every node",
  LoadBalancer: "reachable through a load balancer",
  ExternalName: "an alias for another host name",
};
const headless = computed(() => spec.value.clusterIP === "None");
const external = computed(() =>
  [
    ...(props.resource.status?.loadBalancer?.ingress ?? []).map((i: any) => i.hostname ?? i.ip),
    ...(spec.value.externalIPs ?? []),
  ].filter(Boolean)
);
const selector = computed(() => Object.entries(spec.value.selector ?? {}));

/* ------------------------------------------------------- endpoints -- */

const { items: slices, loading: slicesLoading } = useRelatedList(() => "EndpointSlice", () => target.value, ns);
const { items: pods } = useRelatedList(() => (selector.value.length ? "Pod" : null), () => target.value, ns);
const endpoints = computed(() => serviceEndpoints(props.resource, slices.value));
const ready = computed(() => endpoints.value.filter((e) => e.ready).length);
const endpointPods = computed(() => {
  const byName = new Map(pods.value.map((pod: any) => [pod.metadata?.name, pod]));
  return endpoints.value.map((e) => byName.get(e.targetRef?.name)).filter(Boolean);
});
/* Addresses without a pod (manual endpoints, external IPs). */
const bareEndpoints = computed(() => endpoints.value.filter((e) => e.targetRef?.kind !== "Pod"));
const endpointsHint = computed(() => {
  if (!endpoints.value.length) return slicesLoading.value ? undefined : "None";
  const notReady = endpoints.value.length - ready.value;
  return notReady ? `${ready.value} ready · ${notReady} not ready` : `${ready.value} ready`;
});

/* ---------------------------------------------------------- routes -- */

const { items: ingresses } = useRelatedList(() => "Ingress", () => target.value, ns);
const gatewayApi = useServed(() => target.value, "HTTPRoute", "gateway.networking.k8s.io");
const { items: routes } = useRelatedList(() => (gatewayApi.value ? "HTTPRoute" : null), () => target.value, ns);
const routedBy = computed(() => [
  ...ingressesFor(props.resource, ingresses.value).map((object) => ({ object, kind: "Ingress", hosts: (object.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean) })),
  ...httpRoutesFor(props.resource, routes.value).map((object) => ({ object, kind: "HTTPRoute", hosts: object.spec?.hostnames ?? [] })),
]);

/* ------------------------------------------------------------ ports -- */

const forward = (port: number) =>
  spawnDialog({
    title: "Port Forward",
    message: "Forward ports from the pod to your local machine",
    component: defineAsyncComponent(() => import("@/views/dialogs/PortForward.vue")),
    props: {
      context: target.value.context,
      namespace: namespace.value ?? "",
      kubeConfig: target.value.kubeConfig,
      object: props.resource,
      port,
    },
    buttons: [],
  });
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Type">
        {{ headless ? "Headless" : (spec.type ?? "ClusterIP") }}
        <span class="text-xs text-muted-foreground">
          · {{ headless ? "no cluster IP; DNS returns the pods" : TYPE_WORDS[spec.type ?? "ClusterIP"] }}</span
        >
      </Fact>
      <Fact v-if="spec.clusterIP && !headless" label="Cluster IP" mono :value="spec.clusterIP" />
      <Fact v-if="spec.type === 'ExternalName'" label="Points to" mono :value="spec.externalName" />
      <Fact v-if="spec.type === 'LoadBalancer' || external.length" label="External">
        <span v-if="external.length" class="font-mono text-xs">{{ external.join(", ") }}</span>
        <span v-else class="text-warning">Waiting for an address</span>
      </Fact>
      <Fact label="Selects">
        <span v-if="selector.length" class="flex flex-wrap gap-1">
          <span
            v-for="[key, value] in selector"
            :key="key"
            class="inline-flex h-5 max-w-full items-center truncate rounded bg-muted px-1.5 font-mono text-xs"
            :title="`${key}=${value}`"
            >{{ key }}=<span class="text-foreground">{{ value }}</span></span
          >
        </span>
        <span v-else class="text-muted-foreground">No selector: endpoints are managed separately</span>
      </Fact>
      <Fact v-if="spec.sessionAffinity === 'ClientIP'" label="Sticky" value="Each client keeps its pod" />
      <Fact
        v-if="spec.externalTrafficPolicy === 'Local'"
        label="Traffic"
        value="Stays on the node it arrives at (client IPs kept)"
      />
    </FactList>
  </PanelSection>

  <PanelSection v-if="spec.ports?.length" value="ports" title="Ports" :icon="Cable" :count="spec.ports.length">
    <ul class="divide-y divide-border-subtle">
      <li
        v-for="port in spec.ports"
        :key="`${port.port}/${port.protocol}`"
        class="flex items-center gap-3 py-1.5 first:pt-0 last:pb-0"
      >
        <span class="w-16 shrink-0 truncate text-xs text-muted-foreground" :title="port.name">{{ port.name || "–" }}</span>
        <span class="min-w-0 flex-1 font-mono text-xs tabular-nums select-text">
          {{ portMapping(port) }}
          <span class="text-muted-foreground">{{ port.protocol ?? "TCP" }}</span>
          <span v-if="port.nodePort" class="text-muted-foreground"> · node {{ port.nodePort }}</span>
        </span>
        <Button
          v-if="(port.protocol ?? 'TCP') === 'TCP' && spec.type !== 'ExternalName'"
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 text-muted-foreground"
          :title="`Forward port ${port.port} to your machine`"
          @click="forward(port.port)"
        >
          Forward…
        </Button>
      </li>
    </ul>
  </PanelSection>

  <PanelSection
    v-if="spec.type !== 'ExternalName'"
    value="endpoints"
    title="Endpoints"
    :icon="Split"
    :hint="endpointsHint"
  >
    <div class="space-y-2">
      <p
        v-if="!endpoints.length && !slicesLoading"
        class="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-foreground"
      >
        {{ selector.length ? "No pods match its selector, so traffic to it goes nowhere." : "No endpoints." }}
      </p>
      <p v-else-if="endpoints.length && !ready" class="text-xs text-destructive">
        None of its {{ plural(endpoints.length, "pod") }} is ready: requests fail.
      </p>
      <PodList v-if="endpointPods.length" :pods="endpointPods" :now="now" :detail="(pod) => pod.status?.podIP" />
      <ul v-if="bareEndpoints.length" class="space-y-1 font-mono text-xs">
        <li v-for="endpoint in bareEndpoints" :key="endpoint.addresses.join()" class="flex items-center gap-2 px-1.5">
          <span class="h-1.5 w-1.5 rounded-full" :class="endpoint.ready ? 'bg-success' : 'bg-warning'" />
          {{ endpoint.addresses.join(", ") }}
        </li>
      </ul>
    </div>
  </PanelSection>

  <PanelSection v-if="routedBy.length" value="routes" title="Routed from" :icon="Route" :count="routedBy.length">
    <ul class="space-y-2">
      <li v-for="route in routedBy" :key="route.object.metadata?.uid" class="flex min-w-0 items-baseline gap-2">
        <Waypoints class="h-3.5 w-3.5 shrink-0 translate-y-[2px] text-muted-foreground" />
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-baseline gap-1.5">
            <ObjectLink
              :object-ref="{ kind: route.kind, name: route.object.metadata?.name, namespace }"
              :target="target"
              :object="route.object"
            />
            <span class="shrink-0 text-xs text-muted-foreground">{{ route.kind }}</span>
          </span>
          <span v-if="route.hosts.length" class="block truncate text-xs text-muted-foreground">{{
            route.hosts.join(", ")
          }}</span>
        </span>
      </li>
    </ul>
  </PanelSection>
</template>
