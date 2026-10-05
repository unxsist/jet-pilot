<script setup lang="ts">
/**
 * A cluster as people know it: avatar, alias (or name), and its environment
 * badge when one is set. Used in table Context columns, tabs and headers.
 */
import { inject } from "vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import EnvBadge from "@/components/clusters/EnvBadge.vue";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { resolveCluster } from "@/lib/clusters/meta";

const props = withDefaults(
  defineProps<{
    context: string;
    kubeConfig?: string;
    size?: "sm" | "default";
    /** Muted name (table cells). */
    muted?: boolean;
  }>(),
  { size: "sm", kubeConfig: undefined }
);

const state = inject(SettingsContextStateKey, null);
const cluster = computed(() =>
  resolveCluster(state?.settings.value.clusters, props.context, props.kubeConfig)
);
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-2" :title="context">
    <ContextAvatar
      :name="context"
      :kube-config="kubeConfig"
      :size="size"
      class="[--avatar-ring:var(--background)]"
    />
    <span class="truncate" :class="muted ? 'text-muted-foreground' : ''">{{ cluster.displayName }}</span>
    <EnvBadge v-if="cluster.env && !cluster.envInferred" :env="cluster.env" />
  </span>
</template>
