<script setup lang="ts">
/**
 * One-line notice above a terminal on a guarded cluster: protected clusters
 * (production) get a reminder, read-only ones a note that JET Pilot's
 * guardrails don't reach kubectl in the terminal.
 */
import { Lock, ShieldAlert } from "lucide-vue-next";
import { envInfo } from "@/lib/clusters/meta";
import { guardedCluster } from "@/lib/guardrails/backstop";

const props = defineProps<{ context: string; kubeConfig?: string }>();

const cluster = computed(() => guardedCluster(props.context, props.kubeConfig));
const prefix = computed(() =>
  cluster.value.protected
    ? (!cluster.value.envInferred && envInfo(cluster.value.env)?.short) || "PROTECTED"
    : ""
);
</script>

<template>
  <div
    v-if="cluster.protected || cluster.readOnly"
    role="note"
    class="flex h-7 shrink-0 items-center gap-1.5 border-b px-3 text-xs"
    :class="
      cluster.protected
        ? 'border-destructive/20 bg-destructive/[0.06] text-destructive'
        : 'border-warning/20 bg-warning/[0.06] text-warning'
    "
    data-testid="terminal-cluster-banner"
  >
    <ShieldAlert v-if="cluster.protected" class="h-3.5 w-3.5 shrink-0" />
    <Lock v-else class="h-3.5 w-3.5 shrink-0" />
    <span class="min-w-0 truncate">
      <template v-if="prefix">
        <span class="font-semibold tracking-wide">{{ prefix }}</span> ·
      </template>
      <span class="font-medium text-foreground">{{ cluster.displayName }}</span>
      {{ " " }}
      <span class="text-muted-foreground">{{
        cluster.readOnly
          ? "is read-only in JET Pilot; kubectl in this terminal is not restricted."
          : "· commands here run against a protected cluster."
      }}</span>
    </span>
  </div>
</template>
