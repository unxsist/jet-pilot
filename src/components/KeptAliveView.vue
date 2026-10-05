<script setup lang="ts">
/*
 * One cached route view (child of <keep-alive> in RouterViewport), keyed by
 * the route's full path. It isolates the view from route changes it must
 * not react to while hidden:
 *
 * - useRoute() inside the view returns the route the view was created for
 *   (a cached /deployments view must not follow a navigation to /services);
 * - route update guards (onBeforeRouteUpdate) of the view register on a
 *   private record: every distinct full path is its own view instance, so
 *   the view is never "updated" to another location;
 * - provides the isActiveView flag (see @/lib/activeView).
 */
import {
  matchedRouteKey,
  routeLocationKey,
  type RouteLocationNormalizedLoaded,
  type RouteRecordNormalized,
} from "vue-router";
import type { VNode } from "vue";
import { IsActiveViewKey } from "@/lib/activeView";

const props = defineProps<{
  view: VNode;
  route: RouteLocationNormalizedLoaded;
}>();

const active = ref(true);
onActivated(() => (active.value = true));
onDeactivated(() => (active.value = false));
provide(IsActiveViewKey, readonly(active));

provide(routeLocationKey, shallowReactive({ ...props.route }));

const isolatedRecord = {
  ...(props.route.matched[props.route.matched.length - 1] ?? {}),
  leaveGuards: new Set(),
  updateGuards: new Set(),
  enterCallbacks: {},
  instances: {},
} as unknown as RouteRecordNormalized;
provide(matchedRouteKey, computed(() => isolatedRecord));
</script>
<template>
  <component :is="view" />
</template>
