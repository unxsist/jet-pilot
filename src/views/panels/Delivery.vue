<script setup lang="ts">
/**
 * Side panel of a delivery (Flux Kustomization / HelmRelease, Argo CD
 * Application), opened from the GitOps page and from their tables: its
 * state and last message with the actions, its source (and the source's
 * own state), what it put in the cluster, what it waits for, its settings,
 * conditions and events.
 *
 * Live: the object (and its Flux sources) are watched while the panel is
 * open, so a reconcile or sync started here shows its progress and result.
 */
import { useIntervalFn } from "@vueuse/core";
import {
  Boxes,
  CalendarSearch,
  GitBranch,
  Link2,
  ListChecks,
  NotebookPen,
  SlidersHorizontal,
  Tags,
} from "lucide-vue-next";
import { Accordion } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import PanelSection from "@/components/generic/PanelSection.vue";
import Conditions from "@/components/generic/Conditions.vue";
import Events from "@/components/generic/Events.vue";
import MetadataAnnotationsLabels from "@/components/generic/MetadataAnnotationsLabels.vue";
import StatusBlock from "@/views/panels/delivery/StatusBlock.vue";
import SourceSection from "@/views/panels/delivery/SourceSection.vue";
import ResourceList from "@/views/panels/delivery/ResourceList.vue";
import { formatAge } from "@/components/tables/age";
import { injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { useWatchedList } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { pendingFor } from "@/lib/gitops/actions";
import { openDeliveryPanel } from "@/lib/gitops/ui";
import {
  DELIVERY_KINDS,
  SOURCE_KINDS,
  argoResources,
  deliveryKindOf,
  fluxResources,
  fluxSource,
  qualifiedName,
  toDelivery,
  withPending,
  type Condition,
  type Delivery,
  type ObjectRef,
} from "@/lib/gitops/model";

const props = defineProps<{ resource: any }>();

const { context: primaryContext, kubeConfig: primaryKubeConfig } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);

const now = ref(Date.now());
useIntervalFn(() => (now.value = Date.now()), 30_000);

const info = computed(() => DELIVERY_KINDS[deliveryKindOf(props.resource) ?? "Kustomization"]);
const target = computed(() => ({
  context: props.resource.metadata?.context || primaryContext.value,
  kubeConfig: props.resource.metadata?.kubeConfig ?? (props.resource.metadata?.context ? "" : primaryKubeConfig.value),
}));
const namespace = computed<string>(() => props.resource.metadata?.namespace ?? "");

const dependsOn = (object: any): ObjectRef[] =>
  (Array.isArray(object?.spec?.dependsOn) ? object.spec.dependsOn : [])
    .filter((d: any) => d?.name)
    .map((d: any) => ({ kind: object.kind, name: d.name, namespace: d.namespace ?? object.metadata?.namespace ?? "" }));

const fallback = (resource: string, t: { context: string; kubeConfig: string; namespaces: string[] }) =>
  kubectlGetForContext<any>(resource, t.context, t.kubeConfig, t.namespaces);
const forcePolling = () => kubectlPollingForced(settings.value);

/* The delivery and the ones it depends on (same kind), live. */
const own = useWatchedList<any>({
  resource: () => qualifiedName(info.value),
  kind: () => info.value.kind,
  targets: () => [
    {
      ...target.value,
      namespaces: [...new Set([namespace.value, ...dependsOn(props.resource).map((d) => d.namespace)])].filter(Boolean),
    },
  ],
  fallback,
  forcePolling,
});
const live = computed(
  () => own.items.value.find((row) => row.metadata?.uid === props.resource.metadata?.uid) ?? props.resource
);

/* Flux: its source objects (repository, Helm chart), live. */
const refs = computed<ObjectRef[]>(() => (info.value.tool === "flux" ? fluxSource(live.value).refs : []));
const sourceList = (index: number) =>
  useWatchedList<any>({
    resource: () => {
      const kind = SOURCE_KINDS[refs.value[index]?.kind ?? ""];
      return kind ? qualifiedName(kind) : "";
    },
    kind: () => refs.value[index]?.kind,
    targets: () => (refs.value[index] ? [{ ...target.value, namespaces: [refs.value[index]!.namespace] }] : []),
    fallback,
    forcePolling,
  });
const sourceLists = [sourceList(0), sourceList(1)];
const sources = computed(() =>
  refs.value.slice(0, sourceLists.length).map((ref, index) => {
    const list = sourceLists[index]!;
    return {
      ref,
      object: list.items.value.find((r) => r.metadata?.name === ref.name && r.metadata?.namespace === ref.namespace),
      loading: list.loading.value,
    };
  })
);

const delivery = computed<Delivery | null>(() => {
  const found = toDelivery(
    live.value,
    (ref) =>
      sources.value.find((s) => s.ref.kind === ref.kind && s.ref.name === ref.name && s.ref.namespace === ref.namespace)
        ?.object,
    now.value
  );
  return found ? withPending(found, pendingFor(live.value)) : null;
});

/* -------------------------------------------------------- sections -- */

const resources = computed(() =>
  info.value.tool === "argo" ? argoResources(live.value) : fluxResources(live.value)
);

const dependencies = computed(() =>
  dependsOn(live.value).map((ref) => {
    const object = own.items.value.find((r) => r.metadata?.name === ref.name && r.metadata?.namespace === ref.namespace);
    return { ref, object, delivery: object ? toDelivery(object) : null };
  })
);

const duration = (value: unknown) => (typeof value === "string" ? value.replace(/(\d)m0s$/, "$1m").replace(/(\d)h0m$/, "$1h") : "");

/* Settings worth knowing, in words; defaults stay out. */
const settingsList = computed(() => {
  const object = live.value;
  const spec = object.spec ?? {};
  const list: { label: string; value: string }[] = [];
  if (info.value.tool === "argo") {
    const automated = spec.syncPolicy?.automated;
    list.push({
      label: "Sync policy",
      value: automated
        ? ["Automatic", automated.prune && "prune", automated.selfHeal && "self-heal"].filter(Boolean).join(" · ")
        : "Manual",
    });
    const destination = spec.destination ?? {};
    const cluster =
      destination.name ?? (destination.server === "https://kubernetes.default.svc" ? "in-cluster" : destination.server);
    list.push({ label: "Destination", value: [cluster, destination.namespace].filter(Boolean).join(" · ") || "–" });
    if (spec.project) list.push({ label: "Project", value: spec.project });
    const owner = (object.metadata?.ownerReferences ?? []).find((o: any) => o.kind === "ApplicationSet");
    if (owner) list.push({ label: "Generated by", value: `ApplicationSet ${owner.name}` });
    return list;
  }
  if (spec.interval) list.push({ label: "Interval", value: duration(spec.interval) });
  if (spec.timeout) list.push({ label: "Timeout", value: duration(spec.timeout) });
  if (object.kind === "Kustomization") {
    list.push({ label: "Prune", value: spec.prune ? "On" : "Off" });
    if (spec.wait || spec.healthChecks?.length) list.push({ label: "Health checks", value: spec.wait ? "All resources" : `${spec.healthChecks.length}` });
  } else {
    list.push({ label: "Release", value: spec.releaseName ?? (spec.targetNamespace ? `${spec.targetNamespace}-${object.metadata?.name}` : object.metadata?.name) });
  }
  if (spec.targetNamespace) list.push({ label: "Target namespace", value: spec.targetNamespace });
  if (spec.serviceAccountName) list.push({ label: "Service account", value: spec.serviceAccountName });
  return list;
});

const conditions = computed<Condition[]>(() =>
  Array.isArray(live.value.status?.conditions) ? live.value.status.conditions : []
);
const fluxConditions = computed(() => conditions.value.map((c) => ({ ...c, status: c.status ?? "Unknown" })));
/* Argo CD conditions have no status: all of them are warnings or errors. */
const argoConditionTone = (c: Condition) => (/Error$/.test(c.type) ? "destructive" : "warning");

const labelCount = computed(() => Object.keys(live.value.metadata?.labels || {}).length);
const annotationCount = computed(() => Object.keys(live.value.metadata?.annotations || {}).length);

/* Events again when the state changes (a reconcile / sync emits new ones). */
const eventsKey = computed(() => `${delivery.value?.state.label}:${delivery.value?.lastApplied}`);
</script>

<template>
  <div v-if="delivery" class="bg-card">
    <StatusBlock :delivery="delivery" :now="now" />
    <Accordion
      class="w-full"
      type="multiple"
      collapsible
      :default-value="['source', 'resources', 'dependencies', 'settings', 'conditions']"
    >
      <PanelSection value="source" title="Source" :icon="GitBranch">
        <SourceSection :delivery="delivery" :sources="sources" :now="now" />
      </PanelSection>

      <PanelSection v-if="resources.length" value="resources" title="Resources" :icon="Boxes" :count="resources.length">
        <ResourceList :resources="resources" :context="delivery.context" :kube-config="delivery.kubeConfig" />
      </PanelSection>

      <PanelSection
        v-if="dependencies.length"
        value="dependencies"
        title="Depends on"
        :icon="Link2"
        :count="dependencies.length"
      >
        <ul>
          <li v-for="dependency in dependencies" :key="`${dependency.ref.namespace}/${dependency.ref.name}`">
            <button
              type="button"
              class="flex h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/60 focus-ring disabled:cursor-default disabled:hover:bg-transparent"
              :disabled="!dependency.object"
              @click="openDeliveryPanel(setSidePanelComponent, dependency.object)"
            >
              <StatusDot :tone="dependency.delivery?.state.tone ?? 'muted'" size="sm" class="ml-[5px]" />
              <span class="min-w-0 flex-1 truncate">{{ dependency.ref.name }}</span>
              <span
                class="shrink-0 text-xs"
                :class="
                  dependency.delivery && dependency.delivery.state.category !== 'healthy'
                    ? statusTextClass[dependency.delivery.state.tone]
                    : 'text-muted-foreground'
                "
                >{{ dependency.delivery?.state.label ?? (own.loading.value ? "" : "Not found") }}</span
              >
            </button>
          </li>
        </ul>
      </PanelSection>

      <PanelSection value="settings" title="Settings" :icon="SlidersHorizontal">
        <dl class="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          <template v-for="item in settingsList" :key="item.label">
            <dt class="text-muted-foreground">{{ item.label }}</dt>
            <dd class="min-w-0 truncate" :title="item.value">{{ item.value }}</dd>
          </template>
        </dl>
      </PanelSection>

      <PanelSection v-if="conditions.length" value="conditions" title="Conditions" :icon="ListChecks" :count="conditions.length">
        <Conditions v-if="delivery.tool === 'flux'" :conditions="fluxConditions" />
        <ul v-else class="divide-y divide-border-subtle">
          <li v-for="condition in conditions" :key="condition.type" class="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
            <StatusDot :tone="argoConditionTone(condition)" class="mt-1.5" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-sm font-medium">{{ condition.type }}</span>
                <span v-if="condition.lastTransitionTime" class="shrink-0 text-xs tabular-nums text-muted-foreground">{{
                  formatAge(condition.lastTransitionTime)
                }}</span>
              </div>
              <p v-if="condition.message" class="select-text break-words text-xs text-muted-foreground">{{ condition.message }}</p>
            </div>
          </li>
        </ul>
      </PanelSection>

      <PanelSection value="events" title="Events" :icon="CalendarSearch">
        <Suspense>
          <Events :key="eventsKey" :object="live" />
          <template #fallback>
            <div class="space-y-2" aria-label="Fetching events">
              <Skeleton v-for="index in 3" :key="index" class="h-12 w-full" />
            </div>
          </template>
        </Suspense>
      </PanelSection>

      <PanelSection value="labels" title="Labels" :icon="Tags" :count="labelCount">
        <MetadataAnnotationsLabels type="labels" :object="live" />
      </PanelSection>
      <PanelSection value="annotations" title="Annotations" :icon="NotebookPen" :count="annotationCount">
        <MetadataAnnotationsLabels type="annotations" :object="live" />
      </PanelSection>
    </Accordion>
  </div>
</template>
