<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Beer, FileJson, FolderSync, Scale, SquareTerminal, SunMoon } from "lucide-vue-next";

import themesDark from "@/assets/whats-new/themes-dark.webp";
import themesLight from "@/assets/whats-new/themes-light.webp";
import galleryDark from "@/assets/whats-new/gallery-dark.webp";
import galleryLight from "@/assets/whats-new/gallery-light.webp";
import editorDark from "@/assets/whats-new/theme-editor-dark.webp";
import editorLight from "@/assets/whats-new/theme-editor-light.webp";
import paletteDark from "@/assets/whats-new/palette-dark.webp";
import paletteLight from "@/assets/whats-new/palette-light.webp";

const slides = [
  {
    title: "Make JET Pilot yours",
    description:
      "Themes are here. Pick from JET, the Blossom, Grove, Ocean, Ember and Iris palettes and favourites like Catppuccin, Tokyo Night, Dracula, Nord, GitHub, One Dark Pro, Rosé Pine and Gruvbox — hover a card to preview it on the whole app. Find them in Settings › Appearance.",
    dark: themesDark,
    light: themesLight,
  },
  {
    title: "Bring the theme you already love",
    description:
      "Drop in a VS Code, Sublime Text or TextMate theme, or a JET Pilot theme file, or install one from the Open VSX gallery without leaving the app. Light and dark variants are paired automatically, and the editor and terminal pick up the theme's own syntax and ANSI colours.",
    dark: galleryDark,
    light: galleryLight,
  },
  {
    title: "Write your own in JSON",
    description:
      "Two colours are enough: set a canvas and an accent and the rest is derived, with readable contrast guaranteed. The theme editor completes every colour role, shows swatches and previews your changes live.",
    dark: editorDark,
    light: editorLight,
  },
  {
    title: "Switch in a keystroke",
    description:
      "Press Mod+Alt+A for the theme picker: arrow through the list to preview each theme, Enter to keep it, Esc to go back. Mod+Alt+Shift+A cycles between system, light and dark.",
    dark: paletteDark,
    light: paletteLight,
  },
];

const underTheHood = [
  {
    icon: SunMoon,
    title: "Light and dark, separately",
    text: "Choose one theme for light mode and another for dark — JET Pilot follows your system.",
  },
  {
    icon: SquareTerminal,
    title: "Editor and terminal follow",
    text: "Syntax colours in the YAML editor and the terminal's 16 colours come from your theme.",
  },
  {
    icon: FolderSync,
    title: "Live theme files",
    text: "Themes are plain JSON files in the themes folder; edit one in any editor and the app updates instantly.",
  },
  {
    icon: FileJson,
    title: "Portable theme files",
    text: "Export any theme as a standard JSON theme file to share it.",
  },
  {
    icon: Scale,
    title: "MIT, all the way",
    text: "Every built-in theme is MIT-licensed, and the gallery only installs MIT-licensed themes.",
  },
  {
    icon: Beer,
    title: "Homebrew tap",
    text: "On macOS: brew install --cask unxsist/tap/jet-pilot — it opens right away, no quarantine step.",
  },
];
</script>
<template>
  <Carousel :opts="{ loop: true }" class="min-w-0 w-full">
    <CarouselContent>
      <CarouselItem v-for="slide in slides" :key="slide.title">
        <div>
          <img
            :src="slide.dark"
            :alt="slide.title"
            class="hidden w-full rounded-lg border shadow-xs dark:block"
          />
          <img
            :src="slide.light"
            :alt="slide.title"
            class="w-full rounded-lg border shadow-xs dark:hidden"
          />
          <h3 class="mt-4 text-base font-semibold">{{ slide.title }}</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ slide.description }}
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <h3 class="text-base font-semibold">And under the hood</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            The details that make every theme feel at home.
          </p>
          <div class="mt-4 grid grid-cols-2 gap-3 pr-4">
            <div
              v-for="item in underTheHood"
              :key="item.title"
              class="flex min-w-0 gap-3 rounded-lg border bg-card p-3"
            >
              <component
                :is="item.icon"
                class="mt-0.5 h-4 w-4 shrink-0 text-primary"
              />
              <div>
                <div class="text-sm font-medium">{{ item.title }}</div>
                <div class="mt-0.5 text-xs text-muted-foreground">
                  {{ item.text }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </CarouselItem>
    </CarouselContent>
    <CarouselPrevious />
    <CarouselNext />
  </Carousel>
</template>
