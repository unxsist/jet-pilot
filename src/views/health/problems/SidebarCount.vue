<script setup lang="ts">
/**
 * The calm count on the sidebar's Health link: how many problems aren't
 * snoozed, with a dot in the colour of the worst. Nothing when nothing is
 * broken.
 */
import { StatusDot } from "@/components/ui/status";
import { injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { activeTargets } from "@/lib/multicontext";
import { plural } from "@/lib/resources/format";
import { useProblemCount } from "@/lib/health/problems/feed";

const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const { count, tone } = useProblemCount(() => activeTargets(contexts.value, contextKubeConfigMapping.value));
</script>

<template>
  <span
    v-if="count"
    class="flex shrink-0 items-center gap-1.5 text-2xs font-medium tabular-nums text-muted-foreground"
    :title="`${plural(count, 'problem')} on the active clusters`"
  >
    <StatusDot :tone="tone" size="sm" />
    {{ count }}
  </span>
</template>
