<script setup lang="ts">
import SettingsSection from "@/components/settings/SettingsSection.vue";
import ThemeLibrary from "@/components/settings/themes/ThemeLibrary.vue";
import AddTheme from "@/components/settings/themes/AddTheme.vue";
import ThemeGallery from "@/components/settings/themes/ThemeGallery.vue";
import { Check } from "lucide-vue-next";
import { useTheme } from "@/providers/ThemeProvider";

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { varsStyle } from "@/components/settings/themes/shared";
import type { ThemeAppearance } from "@/lib/themes/types";

const { settings } = injectStrict(SettingsContextStateKey);
const theme = useTheme();
const { setColorScheme } = theme;

/* The mode cards show the theme each mode uses. */
const modeVars = shallowReactive<Partial<Record<ThemeAppearance, Record<string, string>>>>({});
watch(
  () => [settings.value.appearance.lightTheme, settings.value.appearance.darkTheme, theme.themes.value] as const,
  ([lightTheme, darkTheme]) => {
    for (const [appearance, id] of [["light", lightTheme], ["dark", darkTheme]] as const) {
      theme
        .resolve(id, appearance)
        .then((resolved) => (modeVars[appearance] = resolved.vars))
        .catch(() => delete modeVars[appearance]);
    }
  },
  { immediate: true }
);
/* A single-appearance theme paints its own appearance in the other mode. */
const modeClass = (appearance: ThemeAppearance) => {
  const id = appearance === "light" ? settings.value.appearance.lightTheme : settings.value.appearance.darkTheme;
  const entry = theme.themes.value.find((item) => item.id === id);
  return entry && entry.appearances.length === 1 ? entry.appearances[0]! : appearance;
};

const schemes = [
  { value: "auto", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;
</script>
<template>
  <SettingsSection
    title="Mode"
    description="Light, dark, or follow your system. Each mode has its own theme."
  >
    <div
      class="grid grid-cols-3 gap-3 px-5 py-4"
      role="radiogroup"
      aria-label="Color scheme"
    >
      <button
        v-for="scheme in schemes"
        :key="scheme.value"
        type="button"
        role="radio"
        :aria-checked="settings.appearance.colorScheme === scheme.value"
        class="group rounded-lg border p-1.5 text-left transition-[border-color,box-shadow] duration-fast hover:border-border-strong focus-ring focus-visible:ring-offset-card"
        :class="
          settings.appearance.colorScheme === scheme.value
            ? 'border-primary ring-2 ring-primary/20'
            : ''
        "
        @click="setColorScheme(scheme.value)"
      >
        <!-- Mini app previews rendered with the real theme tokens -->
        <div
          class="relative flex h-20 overflow-hidden rounded-md border"
          aria-hidden="true"
        >
          <div
            v-for="(mode, index) in scheme.value === 'auto'
              ? (['light', 'dark'] as const)
              : ([scheme.value] as const)"
            :key="mode"
            :class="[modeClass(mode), index === 1 ? 'border-l' : '']"
            :style="varsStyle(modeVars[mode])"
            class="flex flex-1 bg-sidebar"
          >
            <div class="w-1/4 space-y-1 p-1.5">
              <div class="h-1.5 w-full rounded-sm bg-primary"></div>
              <div class="h-1 w-3/4 rounded-sm bg-muted-foreground/30"></div>
              <div class="h-1 w-2/3 rounded-sm bg-muted-foreground/30"></div>
            </div>
            <div
              class="m-1 ml-0 flex-1 space-y-1.5 rounded-sm border bg-background p-1.5"
            >
              <div class="h-1 w-3/4 rounded-sm bg-foreground/60"></div>
              <div class="h-1 w-1/2 rounded-sm bg-muted-foreground/40"></div>
              <div class="flex items-center gap-1">
                <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                <div class="h-1 w-1/3 rounded-sm bg-muted-foreground/40"></div>
              </div>
              <div class="flex items-center gap-1">
                <span class="h-1.5 w-1.5 rounded-full bg-destructive"></span>
                <div class="h-1 w-2/5 rounded-sm bg-muted-foreground/40"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="flex items-center justify-between px-1 pb-0.5 pt-2">
          <span class="text-sm font-medium">{{ scheme.label }}</span>
          <Check
            v-if="settings.appearance.colorScheme === scheme.value"
            class="h-3.5 w-3.5 text-primary"
          />
        </div>
      </button>
    </div>
  </SettingsSection>

  <ThemeLibrary />
  <AddTheme />
  <ThemeGallery />
</template>
