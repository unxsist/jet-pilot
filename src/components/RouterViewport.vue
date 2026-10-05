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
/* Every cluster, to pick one, when a view needs a context and none is active. */
const ClustersHub = defineAsyncComponent(() => import("@/views/clusters/ClustersHub.vue"));
import { KEEP_ALIVE_MAX, KEEP_ALIVE_ROUTES } from "@/lib/activeView";
import { credentialView } from "@/lib/auth/center";

const { context, contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const route = useRoute();

/* Active clusters that need a sign-in: a notice above every view (lazy). */
const ActiveClustersAuthNotice = defineAsyncComponent(
  () => import("@/components/auth/ActiveClustersAuthNotice.vue")
);
const authNotice = computed(
  () =>
    !!route.meta.requiresContext &&
    [...contexts.value.keys()].some((name) => {
      const view = credentialView({
        context: name,
        kubeConfig: contextKubeConfigMapping.value.get(name) ?? "",
      });
      return view.needsSignIn && view.canSignIn;
    })
);

/*
 * Resource lists are kept alive (bounded, keyed by path + query) so going
 * back to one is instant: rows, scroll position, filters and column state
 * are still there. See @/lib/activeView for how hidden views pause.
 */
const isCached = (r: RouteLocationNormalizedLoaded) =>
  KEEP_ALIVE_ROUTES.includes(String(r.name ?? ""));

// The startup mark jet:data:first is recorded by the data composables
// (useWatchedList / useResourceList) once their first rows are rendered.
</script>
<template>
  <div class="relative flex h-full w-full flex-col bg-background">
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel>
        <ClustersHub v-if="route.meta.requiresContext && context == ''" embedded />
        <div v-else class="flex h-full flex-col">
          <ActiveClustersAuthNotice v-if="authNotice" />
          <div class="min-h-0 flex-1">
            <router-view v-slot="{ Component, route: viewRoute }">
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
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <TabOrchestrator />
    </ResizablePanelGroup>
  </div>
</template>
