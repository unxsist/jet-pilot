/**
 * "Is this view the visible one?" for views kept alive by RouterViewport.
 *
 * Resource list routes (Pods, generic resources, Helm) are cached with
 * <keep-alive> (bounded, keyed by path + query) so navigating back is
 * instant. A cached view stays mounted while hidden, so its timers and
 * subscriptions keep running unless they pause themselves.
 *
 * CONTRACT for data composables (useResourceList / refresher / watch
 * subscriptions):
 *
 *   const active = useIsActiveView();
 *   watch(active, (isActive) => {
 *     if (isActive) { refreshNow(); resumePolling(); }   // or resubscribe
 *     else { pausePolling(); }                           // or unsubscribe
 *   });
 *
 * - While inactive: do not poll; dependency changes (context switches)
 *   should only mark the data stale and reload on activation.
 * - On activation: refresh right away, keep the old rows visible meanwhile.
 * - Outside RouterViewport (tabs, dialogs, tests) the flag is always true.
 *
 * Vue's onActivated / onDeactivated also fire for every component inside a
 * kept-alive view; this flag is the same signal as a ref (usable in
 * watchers and computed state).
 */
import { inject, ref, type InjectionKey, type Ref } from "vue";

export const IsActiveViewKey: InjectionKey<Readonly<Ref<boolean>>> =
  Symbol("IsActiveView");

const alwaysActive: Readonly<Ref<boolean>> = ref(true);

export function useIsActiveView(): Readonly<Ref<boolean>> {
  return inject(IsActiveViewKey, alwaysActive);
}

/** Routes whose views are kept alive (route names, see router.ts). */
export const KEEP_ALIVE_ROUTES = ["Pods", "GenericResource", "HelmCharts"];

/** Maximum number of hidden views kept alive (least recently used dropped). */
export const KEEP_ALIVE_MAX = 6;
