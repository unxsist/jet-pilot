<script setup lang="ts">
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
import SplitPanes from "@/components/SplitPanes.vue";
import { useRoute } from "vue-router";
import { SplitViewKey } from "@/providers/SplitViewProvider";
/* Every cluster, to pick one, when a view needs a context and none is active. */
const ClustersHub = defineAsyncComponent(() => import("@/views/clusters/ClustersHub.vue"));
import { credentialView } from "@/lib/auth/center";

const { context, contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const route = useRoute();
const split = injectStrict(SplitViewKey);

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
 * Views are shown by SplitPanes (one pane, or two side by side). Resource
 * lists are kept alive per pane (bounded, keyed by path + query) so going
 * back to one is instant: rows, scroll position, filters and column state
 * are still there. See @/lib/activeView for how hidden views pause.
 * Full-width pages (Settings) are rendered by <router-view> instead, which
 * also runs their route guards (unsaved changes).
 */
// The startup mark jet:data:first is recorded by the data composables
// (useWatchedList / useResourceList) once their first rows are rendered.
</script>
<template>
  <!-- Focus lands here when the command palette's return target is gone. -->
  <div
    class="relative flex h-full w-full flex-col bg-background outline-none"
    tabindex="-1"
    data-focus-fallback
  >
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel>
        <ClustersHub v-if="route.meta.requiresContext && context == ''" embedded />
        <div v-else class="flex h-full flex-col">
          <ActiveClustersAuthNotice v-if="authNotice" />
          <div class="min-h-0 flex-1">
            <router-view v-if="split.suspended.value" v-slot="{ Component }">
              <component :is="Component" v-if="Component" />
            </router-view>
            <SplitPanes v-show="!split.suspended.value" />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <TabOrchestrator />
    </ResizablePanelGroup>
  </div>
</template>
