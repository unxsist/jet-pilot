<script setup lang="ts">
/** An event: what happened, to which object (a link), how often and when. */
import { Activity } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import { useNow, usePanelTarget } from "@/composables/usePanelObject";
import { formatDateTime } from "@/lib/utils";
import { ago, plural, toMs } from "@/lib/resources/format";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const involved = computed(() => props.resource.involvedObject ?? props.resource.regarding ?? {});
const warning = computed(() => props.resource.type === "Warning");
const count = computed(() => props.resource.count ?? props.resource.series?.count ?? 1);
const first = computed(() => props.resource.firstTimestamp ?? props.resource.eventTime ?? props.resource.metadata?.creationTimestamp);
const last = computed(
  () => props.resource.lastTimestamp ?? props.resource.series?.lastObservedTime ?? props.resource.eventTime ?? first.value
);
const source = computed(() => {
  const s = props.resource.source ?? {};
  const component = s.component ?? props.resource.reportingComponent ?? props.resource.reportingController;
  const host = s.host ?? props.resource.reportingInstance;
  return [component, host && host !== component ? `on ${host}` : ""].filter(Boolean).join(" ");
});
const when = (value: unknown) => {
  const ms = toMs(value);
  return ms === null ? undefined : formatDateTime(new Date(ms));
};
</script>

<template>
  <PanelSection value="event" title="Event" :icon="Activity">
    <div class="space-y-4">
      <div>
        <div class="text-base font-semibold" :class="warning ? 'text-warning' : 'text-foreground'">
          {{ resource.reason ?? "Event" }}
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed select-text">{{ resource.message ?? resource.note }}</p>
      </div>
      <FactList>
        <Fact label="About">
          <span v-if="involved.name" class="inline-flex min-w-0 items-baseline gap-1.5">
            <span class="shrink-0 text-xs text-muted-foreground">{{ involved.kind }}</span>
            <ObjectLink
              :object-ref="{
                kind: involved.kind,
                name: involved.name,
                namespace: involved.namespace,
                apiVersion: involved.apiVersion,
              }"
              :target="target"
            />
          </span>
          <span v-else class="text-muted-foreground">–</span>
        </Fact>
        <Fact v-if="involved.fieldPath" label="Part" mono :value="involved.fieldPath" />
        <Fact label="Seen">
          {{ count > 1 ? plural(count, "time") : "Once" }}
        </Fact>
        <Fact v-if="count > 1" label="First" :title="when(first)" :value="ago(first, now)" />
        <Fact label="Last" :title="when(last)" :value="ago(last, now)" />
        <Fact v-if="source" label="Reported by" :value="source" />
      </FactList>
    </div>
  </PanelSection>
</template>
