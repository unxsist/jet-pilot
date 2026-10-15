<script setup lang="ts">
/**
 * An Ingress: its class and address, its rules as host → path → Service
 * (each Service a link, missing ones called out) and its TLS hosts with
 * their certificate Secrets.
 */
import { ArrowRight, Info, Lock, Route } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import { usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { ingressRoutes } from "@/lib/resources/network";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const spec = computed(() => props.resource.spec ?? {});
const namespace = computed(() => props.resource.metadata?.namespace as string);
const ingressClass = computed(
  () => spec.value.ingressClassName ?? props.resource.metadata?.annotations?.["kubernetes.io/ingress.class"]
);
const addresses = computed(() =>
  (props.resource.status?.loadBalancer?.ingress ?? []).map((i: any) => i.hostname ?? i.ip).filter(Boolean)
);

const tls = computed<{ hosts?: string[]; secretName?: string }[]>(() => spec.value.tls ?? []);
const secured = computed(() => new Set(tls.value.flatMap((t) => t.hosts ?? [])));

/* Routes grouped by host, in rule order. */
const hosts = computed(() => {
  const groups = new Map<string, ReturnType<typeof ingressRoutes>>();
  for (const route of ingressRoutes(props.resource)) {
    if (!groups.has(route.host)) groups.set(route.host, []);
    groups.get(route.host)!.push(route);
  }
  return [...groups.entries()].map(([host, routes]) => ({ host, routes }));
});
const routeCount = computed(() => hosts.value.reduce((sum, h) => sum + h.routes.length, 0));

/* Backends that don't exist (from the namespace's Service watch). */
const { items: services, loading } = useRelatedList(() => "Service", () => target.value, () => (namespace.value ? [namespace.value] : null));
const missing = (name?: string) =>
  !!name && !loading.value && services.value.length > 0 && !services.value.some((s: any) => s.metadata?.name === name);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Class">
        <ObjectLink v-if="ingressClass" :object-ref="{ kind: 'IngressClass', name: ingressClass }" :target="target" />
        <span v-else class="text-muted-foreground">The cluster's default</span>
      </Fact>
      <Fact label="Address">
        <span v-if="addresses.length" class="font-mono text-xs">{{ addresses.join(", ") }}</span>
        <span v-else class="text-warning">None yet</span>
      </Fact>
    </FactList>
  </PanelSection>

  <PanelSection v-if="routeCount" value="rules" title="Rules" :icon="Route" :count="routeCount">
    <div class="space-y-4">
      <div v-for="group in hosts" :key="group.host">
        <div class="mb-1.5 flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Lock v-if="secured.has(group.host)" class="h-3 w-3 shrink-0 text-success" aria-label="TLS" />
          <span class="truncate select-text">{{ group.host === "*" ? "Any host" : group.host }}</span>
        </div>
        <ul
          class="grid grid-cols-[max-content_auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1 border-l border-border-subtle pl-3 text-xs"
        >
          <li v-for="route in group.routes" :key="`${route.path}->${route.service ?? route.resource}`" class="contents">
            <span class="max-w-[11rem] truncate font-mono select-text" :title="`${route.path} (${route.pathType ?? 'Prefix'})`">{{
              route.path
            }}</span>
            <ArrowRight class="h-3 w-3 translate-y-[2px] text-muted-foreground" aria-hidden="true" />
            <span class="flex min-w-0 items-baseline gap-1 text-sm">
              <template v-if="route.service">
                <ObjectLink :object-ref="{ kind: 'Service', name: route.service, namespace }" :target="target" />
                <span v-if="route.port" class="shrink-0 text-xs text-muted-foreground">:{{ route.port }}</span>
                <span v-if="missing(route.service)" class="shrink-0 text-xs text-warning">doesn't exist</span>
              </template>
              <span v-else class="truncate text-muted-foreground">{{ route.resource ?? "–" }}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </PanelSection>

  <PanelSection v-if="tls.length" value="tls" title="TLS" :icon="Lock" :count="tls.length">
    <FactList>
      <Fact v-for="(entry, index) in tls" :key="index" :label="(entry.hosts ?? []).join(', ') || 'Every host'">
        <ObjectLink
          v-if="entry.secretName"
          :object-ref="{ kind: 'Secret', name: entry.secretName, namespace }"
          :target="target"
        />
        <span v-else class="text-muted-foreground">The controller's default certificate</span>
      </Fact>
    </FactList>
  </PanelSection>
</template>
