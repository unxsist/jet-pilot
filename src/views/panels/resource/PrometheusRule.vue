<script setup lang="ts">
import { Siren } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import { statusTextClass } from "@/components/ui/status";
import { groupOf } from "@/lib/operators/format";
import { ruleGroups, ruleSummary } from "@/lib/operators/prometheus";

/* Prometheus Operator PrometheusRules: the alerts per group, lightly. */
const props = defineProps<{ resource: any }>();

const isPrometheusOperator = computed(
  () => groupOf(props.resource?.apiVersion) === "monitoring.coreos.com"
);
const groups = computed(() => ruleGroups(props.resource));
const summary = computed(() => ruleSummary(props.resource));

const severityClass = (severity?: string) =>
  severity === "critical"
    ? statusTextClass.destructive
    : severity === "warning"
      ? statusTextClass.warning
      : "text-muted-foreground";
</script>

<template>
  <PanelSection
    v-if="isPrometheusOperator"
    value="spec"
    title="Rules"
    :icon="Siren"
    :count="summary.alerts + summary.records"
  >
    <div class="space-y-4 text-xs">
      <section v-for="group in groups" :key="group.name" class="space-y-1.5">
        <h4 class="flex items-baseline justify-between gap-2">
          <span class="font-medium">{{ group.name }}</span>
          <span v-if="group.interval" class="text-muted-foreground">every {{ group.interval }}</span>
        </h4>
        <ul class="divide-y divide-border-subtle">
          <li v-for="alert in group.alerts" :key="alert.name" class="py-1.5" :title="alert.expr">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate">{{ alert.name }}</span>
              <span class="shrink-0" :class="severityClass(alert.severity)">
                {{ alert.severity ?? "" }}<template v-if="alert.for"> · {{ alert.for }}</template>
              </span>
            </div>
            <p v-if="alert.summary" class="truncate text-muted-foreground">{{ alert.summary }}</p>
          </li>
        </ul>
        <p v-if="group.records.length" class="text-muted-foreground">
          {{ group.records.length }} recording rule{{ group.records.length === 1 ? "" : "s" }}
        </p>
      </section>
    </div>
  </PanelSection>
</template>
