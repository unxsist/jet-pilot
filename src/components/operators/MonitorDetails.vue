<script setup lang="ts">
/** Side panel of a Prometheus Operator ServiceMonitor / PodMonitor. */
import { Radar } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import Fields from "./Fields.vue";
import Field from "./Field.vue";
import { groupOf } from "@/lib/operators/format";
import { monitorEndpoints, monitorTargetInWords } from "@/lib/operators/prometheus";

const props = defineProps<{ resource: any }>();

const isPrometheusOperator = computed(
  () => groupOf(props.resource?.apiVersion) === "monitoring.coreos.com"
);
const endpoints = computed(() => monitorEndpoints(props.resource));
</script>

<template>
  <PanelSection v-if="isPrometheusOperator" value="spec" title="Scraping" :icon="Radar">
    <Fields>
      <Field label="Scrapes" :value="monitorTargetInWords(resource)" />
      <Field label="Endpoints" v-if="endpoints.length">
        <ul class="space-y-0.5">
          <li v-for="endpoint in endpoints" :key="endpoint">{{ endpoint }}</li>
        </ul>
      </Field>
      <Field label="Job label" :value="resource.spec?.jobLabel" />
    </Fields>
  </PanelSection>
</template>
