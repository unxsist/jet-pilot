import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useColorMode } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";

export default {
  async setup() {
    const { settings } = injectStrict(SettingsContextStateKey);
    const colorMode = useColorMode();

    colorMode.value = settings.value.appearance.colorScheme;
  },
  render(): any {
    return this.$slots.default();
  },
};
