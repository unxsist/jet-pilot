import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  register,
  unregister,
  unregisterAll,
} from "@tauri-apps/api/globalShortcut";
import { useRouter } from "vue-router";

export const GlobalShortcutRegisterShortcutsKey: InjectionKey<() => void> =
  Symbol("GlobalShortcutRegisterShortcuts");

export default {
  name: "GlobalShortcutProvider",
  async setup() {
    const state = reactive({
      shortcuts: [] as string[],
    });

    const { settings } = injectStrict(SettingsContextStateKey);
    const router = useRouter();

    const registerShortcuts = async () => {
      await clearShortcuts();

      settings.value.pinnedResources.forEach((resource, index) => {
        if (index > 8) return;

        register("CommandOrControl+" + (index + 1), () => {
          router.push({
            path: `/${resource.name}`,
            query: { resource: resource.name },
          });
        });
        state.shortcuts.push("CommandOrControl+" + (index + 1));
      });
    };

    provide(GlobalShortcutRegisterShortcutsKey, registerShortcuts);

    const clearShortcuts = async () => {
      state.shortcuts.forEach((shortcut) => {
        unregister(shortcut);
      });
      state.shortcuts = [];
    };

    unregisterAll();
    registerShortcuts();
  },
  render(): any {
    return this.$slots.default();
  },
};
