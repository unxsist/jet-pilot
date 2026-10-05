<script setup lang="ts">
/**
 * One-line notice above a terminal on a guarded cluster: protected clusters
 * (production) get a reminder, read-only ones a note that JET Pilot's
 * guardrails don't reach kubectl in the terminal.
 */
import { Lock, ShieldAlert } from "lucide-vue-next";
import EnvBadge from "@/components/clusters/EnvBadge.vue";
import { guardedCluster } from "@/lib/guardrails/backstop";

const props = defineProps<{ context: string; kubeConfig?: string }>();

const cluster = computed(() => guardedCluster(props.context, props.kubeConfig));
</script>

<template>
  <div
    v-if="cluster.protected || cluster.readOnly"
    role="note"
    class="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs"
    :class="
      cluster.protected
        ? 'border-destructive/20 bg-destructive/[0.06]'
        : 'border-warning/20 bg-warning/[0.06]'
    "
    data-testid="terminal-cluster-banner"
  >
    <ShieldAlert v-if="cluster.protected" class="h-3.5 w-3.5 shrink-0 text-destructive" />
    <Lock v-else class="h-3.5 w-3.5 shrink-0 text-warning" />
    <span class="shrink-0 font-medium text-foreground">{{ cluster.displayName }}</span>
    <EnvBadge v-if="cluster.env && !cluster.envInferred" :env="cluster.env" />
    <span class="min-w-0 truncate text-muted-foreground">
      {{
        cluster.readOnly
          ? "Read-only in JET Pilot; kubectl in this terminal is not restricted."
          : "Commands here run against a protected cluster."
      }}
    </span>
  </div>
</template>
