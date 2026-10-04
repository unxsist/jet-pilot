import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useColorMode } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import { SetupContext, watch } from "vue";

/**
 * Applies the colour scheme from the settings. Synchronous: VueUse persists
 * the last mode in localStorage (`vueuse-color-scheme`) and public/boot.js
 * applies it before the first paint, so there is nothing to wait for.
 */
export default {
  name: "ColorSchemeProvider",
  setup(_props: unknown, { slots }: SetupContext) {
    const { settings } = injectStrict(SettingsContextStateKey);
    const colorMode = useColorMode();

    watch(
      () => settings.value.appearance.colorScheme,
      (scheme) => {
        colorMode.value = scheme;
      },
      { immediate: true }
    );

    return () => slots.default?.();
  },
};
