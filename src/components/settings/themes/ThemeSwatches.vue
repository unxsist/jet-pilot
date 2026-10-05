<script setup lang="ts">
/*
 * A compact swatch strip of a theme file (not yet installed): per
 * appearance, its canvas, chrome, text, primary and accent colours.
 */
import { useTheme } from "@/providers/ThemeProvider";
import { appearancesOf } from "@/lib/themes/library";
import type { ThemeAppearance, ThemeFile } from "@/lib/themes/types";

const props = defineProps<{ file: ThemeFile }>();
const theme = useTheme();

const strips = ref<{ appearance: ThemeAppearance; colors: string[] }[] | null>(null);

watch(
  () => props.file,
  async (file) => {
    try {
      strips.value = await Promise.all(
        appearancesOf(file).map(async (appearance) => {
          const { roles, vars } = await theme.resolve(file, appearance);
          return {
            appearance,
            colors: [roles.canvas, roles.sidebar, roles.text, `hsl(${vars.primary})`, roles.accent],
          };
        })
      );
    } catch {
      strips.value = [];
    }
  },
  { immediate: true }
);
</script>

<template>
  <div class="flex shrink-0 items-center gap-1.5" aria-hidden="true">
    <template v-if="strips">
      <span
        v-for="strip in strips"
        :key="strip.appearance"
        class="flex h-5 overflow-hidden rounded-[5px] border border-foreground/10"
        :title="strip.appearance"
      >
        <span
          v-for="(color, index) in strip.colors"
          :key="index"
          class="h-full w-2.5"
          :style="{ backgroundColor: color }"
        ></span>
      </span>
    </template>
    <span v-else class="h-5 w-[52px] animate-pulse rounded-[5px] bg-muted"></span>
  </div>
</template>
