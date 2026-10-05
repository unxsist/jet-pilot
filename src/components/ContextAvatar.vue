<script setup lang="ts">
import { inject, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { resolveCluster } from "@/lib/clusters/meta";

/**
 * Square monogram for a kube context ("prod-eu-west-1" -> "PE"), tinted
 * with the colour chosen for the cluster (Clusters hub) or a hue derived
 * from the name, so clusters are recognisable at a glance. An alias gives
 * its own initials. An optional status dot sits on the corner.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    /** Narrows the cluster metadata to this kubeconfig's context. */
    kubeConfig?: string;
    size?: "sm" | "default" | "lg";
    status?: StatusTone | null;
    class?: HTMLAttributes["class"];
  }>(),
  { size: "default", status: null, kubeConfig: undefined }
);

const state = inject(SettingsContextStateKey, null);
const cluster = computed(() =>
  resolveCluster(state?.settings.value.clusters, props.name, props.kubeConfig)
);
const gray = computed(() => cluster.value.color === "gray");
</script>

<template>
  <span
    :class="
      cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-md font-semibold leading-none tracking-tight',
        'bg-[hsl(var(--avatar-h)_70%_50%/0.14)] text-[hsl(var(--avatar-h)_60%_34%)] ring-1 ring-inset ring-[hsl(var(--avatar-h)_60%_50%/0.18)]',
        'dark:bg-[hsl(var(--avatar-h)_70%_60%/0.14)] dark:text-[hsl(var(--avatar-h)_80%_76%)]',
        props.size === 'sm' ? 'h-5 w-5 text-2xs' : props.size === 'lg' ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs',
        gray && 'saturate-0',
        props.class
      )
    "
    :style="{ '--avatar-h': cluster.hue }"
    aria-hidden="true"
  >
    {{ cluster.initials }}
    <StatusDot
      v-if="props.status"
      :tone="props.status"
      :size="props.size === 'sm' ? 'sm' : 'default'"
      class="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[hsl(var(--avatar-ring,var(--sidebar)))]"
    />
  </span>
</template>
