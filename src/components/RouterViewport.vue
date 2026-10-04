<script setup lang="ts">
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
import KeptAliveView from "@/components/KeptAliveView.vue";
import { useRoute, type RouteLocationNormalizedLoaded } from "vue-router";
import NoContext from "@/views/NoContext.vue";
import { KEEP_ALIVE_MAX, KEEP_ALIVE_ROUTES } from "@/lib/activeView";
import { markFirstData, perfMarks } from "@/lib/perf";

const { context } = injectStrict(KubeContextStateKey);
const route = useRoute();

/*
 * Resource lists are kept alive (bounded, keyed by path + query) so going
 * back to one is instant: rows, scroll position, filters and column state
 * are still there. See @/lib/activeView for how hidden views pause.
 */
const isCached = (r: RouteLocationNormalizedLoaded) =>
  KEEP_ALIVE_ROUTES.includes(String(r.name ?? ""));

/*
 * Startup timeline: the first table rows rendered by any view mark
 * jet:data:first (one-shot observer, disconnected afterwards).
 */
const viewport = ref<HTMLElement | null>(null);
onMounted(() => {
  if (!viewport.value || perfMarks()["data:first"] !== undefined) return;
  const hasRows = () => !!viewport.value?.querySelector("tbody tr td");
  if (hasRows()) {
    markFirstData();
    return;
  }
  const observer = new MutationObserver(() => {
    if (hasRows()) {
      markFirstData();
      observer.disconnect();
    }
  });
  observer.observe(viewport.value, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 60_000);
});
</script>
<template>
  <div ref="viewport" class="relative flex h-full w-full flex-col bg-background">
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel>
        <NoContext v-if="route.meta.requiresContext && context == ''" />
        <router-view v-else v-slot="{ Component, route: viewRoute }">
          <keep-alive :max="KEEP_ALIVE_MAX">
            <KeptAliveView
              v-if="Component && isCached(viewRoute)"
              :key="viewRoute.fullPath"
              :view="Component"
              :route="viewRoute"
            />
          </keep-alive>
          <component
            :is="Component"
            v-if="Component && !isCached(viewRoute)"
          />
        </router-view>
      </ResizablePanel>
      <ResizableHandle />
      <TabOrchestrator />
    </ResizablePanelGroup>
  </div>
</template>
