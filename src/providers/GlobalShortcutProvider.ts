import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { RouteLocationRaw, useRouter } from "vue-router";

/**
 * Kept for compatibility: shortcuts are derived from the pinned resources on
 * every key press, so there is nothing to re-register anymore.
 */
export const GlobalShortcutRegisterShortcutsKey: InjectionKey<() => void> =
  Symbol("GlobalShortcutRegisterShortcuts");

/** Route of a resource list, as used by the navigation. */
export function resourceRoute(kind: string): RouteLocationRaw {
  const resource = formatResourceKind(kind).toLowerCase();
  return {
    path: `/${resource}`,
    query: { resource, kind },
  };
}

/** Number of pinned resources reachable with Cmd/Ctrl + 1..9. */
export const PINNED_SHORTCUT_COUNT = 9;

/**
 * Cmd/Ctrl + 1..9 opens the n-th pinned resource.
 *
 * These are handled in-window: registering them as OS-global shortcuts
 * stole the key combinations from every other application (e.g. browser
 * tab switching) while JET Pilot was running.
 */
export default {
  name: "GlobalShortcutProvider",
  setup() {
    const { settings } = injectStrict(SettingsContextStateKey);
    const router = useRouter();
    const isMac = getOsType() === "macos";

    const onKeydown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      if (isMac ? event.ctrlKey : event.metaKey) {
        return;
      }

      // event.code keeps working with non-QWERTY layouts (e.g. AZERTY).
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      if (!match) {
        return;
      }

      const index = Number(match[1]) - 1;
      const resource = settings.value.pinnedResources[index];
      if (!resource || index >= PINNED_SHORTCUT_COUNT) {
        return;
      }

      event.preventDefault();
      router.push(resourceRoute(resource.kind));
    };

    window.addEventListener("keydown", onKeydown);
    onUnmounted(() => window.removeEventListener("keydown", onKeydown));

    provide(GlobalShortcutRegisterShortcutsKey, () => {});
  },
  render(): any {
    return this.$slots.default();
  },
};
