<script setup lang="ts">
/**
 * Keeps the backend recorder on the active clusters and namespaces (see
 * src-tauri/src/changes), so changes are recorded while the app is open,
 * whatever page is shown. Renders nothing; loaded once the app is idle.
 *
 * The first call after a page load restarts the recorders (the reload
 * dropped their watches); a slow heartbeat retries clusters that couldn't
 * be followed (unreachable, signed out).
 */
import { useDebounceFn, useIntervalFn } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { activeTargets } from "@/lib/multicontext";
import { trackChanges } from "@/lib/changes/recorded";
import { error as logError } from "@/lib/logger";

const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const targets = computed(() => activeTargets(contexts.value, contextKubeConfigMapping.value));

let fresh = true;
const track = () => {
  const first = fresh;
  fresh = false;
  trackChanges(targets.value, first).catch((e) => logError(`Changes: the recorder couldn't start: ${e}`));
};
watch(() => JSON.stringify(targets.value), useDebounceFn(track, 1500), { immediate: true });
useIntervalFn(track, 5 * 60_000);
</script>

<template>
  <span hidden />
</template>
