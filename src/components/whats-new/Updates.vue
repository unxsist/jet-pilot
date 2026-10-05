<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  ArrowDownUp,
  KeyRound,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  TerminalSquare,
} from "lucide-vue-next";

import searchDark from "@/assets/whats-new/settings-search-dark.webp";
import searchLight from "@/assets/whats-new/settings-search-light.webp";
import kubeconfigsDark from "@/assets/whats-new/settings-kubeconfigs-dark.webp";
import kubeconfigsLight from "@/assets/whats-new/settings-kubeconfigs-light.webp";
import toolsDark from "@/assets/whats-new/settings-tools-dark.webp";
import toolsLight from "@/assets/whats-new/settings-tools-light.webp";
import jsonDark from "@/assets/whats-new/settings-json-dark.webp";
import jsonLight from "@/assets/whats-new/settings-json-light.webp";

const slides = [
  {
    title: "Settings, rebuilt",
    description:
      "Every setting is one search away: press Mod+, and start typing. Changed values are marked with a dot and go back to their default in one click, and new pages cover the terminal, the editor, tables, logs and more.",
    dark: searchDark,
    light: searchLight,
  },
  {
    title: "Your kubeconfigs, found",
    description:
      "JET Pilot now picks up ~/.kube/config, the files in $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d by itself. Open a file to see each context's sign-in method and what's missing, like a sign-in plugin that isn't installed.",
    dark: kubeconfigsDark,
    light: kubeconfigsLight,
  },
  {
    title: "Tools that just work",
    description:
      "See which command-line tools JET Pilot found and what each is for. Missing kubectl or Helm? Download a checksum-verified copy in one click. Tools you install yourself always come first.",
    dark: toolsDark,
    light: toolsLight,
  },
  {
    title: "settings.json, if you like",
    description:
      "Prefer text? Edit settings.json with completion and validation, or change any setting from the command palette. Export your preferences, workspaces, port forwards and themes to set up another machine in seconds.",
    dark: jsonDark,
    light: jsonLight,
  },
];

const underTheHood = [
  {
    icon: TerminalSquare,
    title: "Terminal your way",
    text: "Font, size, cursor, scrollback, copy on select, and the shell your local terminal starts.",
  },
  {
    icon: SquareTerminal,
    title: "Editor preferences",
    text: "Font size, tab size, word wrap, minimap, line numbers and your preferred diff layout.",
  },
  {
    icon: KeyRound,
    title: "Your shell's environment",
    text: "Started from the Dock or a launcher, JET Pilot now picks up KUBECONFIG, AWS_PROFILE and proxy settings from your login shell, not just PATH.",
  },
  {
    icon: ArrowDownUp,
    title: "Watch or poll",
    text: "Clusters behind proxies that drop long-lived connections can switch lists to polling, with an interval you choose.",
  },
  {
    icon: ScrollText,
    title: "More log context",
    text: "Logs open with the last 200 lines per container, and follow, timestamps and wrapping have defaults you set.",
  },
  {
    icon: ShieldCheck,
    title: "Safe upgrade",
    text: "Your existing settings move over automatically, with a backup of the old file kept next to them.",
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
            The small things that make JET Pilot feel like yours.
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
