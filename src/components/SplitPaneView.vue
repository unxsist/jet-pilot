<script setup lang="ts">
/*
 * The view of one split view pane: the route at `path`, rendered without
 * <router-view> (the router follows the focused pane only). Resource lists
 * are kept alive per pane exactly like they were in the single view
 * (bounded, keyed by full path, see @/lib/activeView); other views are
 * isolated the same way, keyed by route name (no remount when only the
 * query changes). While a full-width page (Settings) is open the pane
 * renders nothing: its cached views are deactivated and pause.
 */
import { h, type Component } from "vue";
import { useRouter, type RouteLocationNormalizedLoaded } from "vue-router";
import KeptAliveView from "@/components/KeptAliveView.vue";
import { KEEP_ALIVE_MAX, KEEP_ALIVE_ROUTES } from "@/lib/activeView";
import { PaneKey } from "@/lib/splitView";

const props = defineProps<{
  index: number;
  path: string;
  suspended: boolean;
}>();

const router = useRouter();

/* For PaneControls in the view's toolbar. */
provide(PaneKey, { index: toRef(props, "index") });

/*
 * The pane's route. Its view component is loaded: the router loaded it when
 * it navigated there, or (a workspace's split) the split view did before
 * showing it (see restore in @/lib/splitViewOps).
 */
const route = computed(() => {
  if (!props.path) return null;
  const resolved = router.resolve(props.path);
  // Only rendered once its component is loaded (`view` below): then it is
  // the loaded location the view would get from <router-view>.
  return resolved.matched.length > 0 ? (resolved as unknown as RouteLocationNormalizedLoaded) : null;
});
const cached = computed(
  () => !!route.value && KEEP_ALIVE_ROUTES.includes(String(route.value.name ?? ""))
);
const component = computed(() => {
  // A lazy view is loaded once the router navigated there.
  void router.currentRoute.value;
  const matched = route.value?.matched;
  const view = matched?.[matched.length - 1]?.components?.default;
  // Still a lazy loader (`() => import(...)`): nothing to render yet.
  return typeof view === "object" ? (view as Component) : null;
});
const view = computed(() => (component.value ? h(component.value) : null));
</script>

<template>
  <keep-alive :max="KEEP_ALIVE_MAX">
    <KeptAliveView
      v-if="!suspended && route && cached && view"
      :key="route.fullPath"
      :view="view"
      :route="route"
    />
  </keep-alive>
  <KeptAliveView
    v-if="!suspended && route && !cached && view"
    :key="String(route.name ?? route.path)"
    :view="view"
    :route="route"
  />
</template>
