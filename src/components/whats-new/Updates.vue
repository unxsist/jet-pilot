<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  Cpu,
  KeyRound,
  Laptop,
  ShieldCheck,
  Gauge,
  Wrench,
} from "lucide-vue-next";

import podsDark from "@/assets/whats-new/pods-dark.webp";
import podsLight from "@/assets/whats-new/pods-light.webp";
import contextsDark from "@/assets/whats-new/context-switcher-dark.webp";
import contextsLight from "@/assets/whats-new/context-switcher-light.webp";
import terminalDark from "@/assets/whats-new/terminal-dark.webp";
import terminalLight from "@/assets/whats-new/terminal-light.webp";
import detailsDark from "@/assets/whats-new/side-panel-dark.webp";
import detailsLight from "@/assets/whats-new/side-panel-light.webp";
import paletteDark from "@/assets/whats-new/command-palette-dark.webp";
import paletteLight from "@/assets/whats-new/command-palette-light.webp";
import graphDark from "@/assets/whats-new/cluster-overview-dark.webp";
import graphLight from "@/assets/whats-new/cluster-overview-light.webp";

const slides = [
  {
    title: "A whole new look",
    description:
      "JET Pilot has been redesigned from the ground up: a new design system, crisp typography, status colours you can read at a glance and polished dark and light themes.",
    dark: podsDark,
    light: podsLight,
  },
  {
    title: "Multiple clusters and namespaces at once",
    description:
      "Connect to several contexts — across all your kubeconfig files — and any mix of namespaces at the same time. Every table aggregates them with Context and Namespace columns.",
    dark: contextsDark,
    light: contextsLight,
  },
  {
    title: "A built-in terminal",
    description:
      "Press Ctrl+` for a terminal with kubectl already pointed at the current context — without touching your own kubeconfig. Shelling into containers now works on Windows too.",
    dark: terminalDark,
    light: terminalLight,
  },
  {
    title: "Richer resource details",
    description:
      "The side panel now shows containers, conditions, labels and events, with one-click access to YAML, describe and logs. Tables gained loading and error states, an actions menu and live status colours.",
    dark: detailsDark,
    light: detailsLight,
  },
  {
    title: "Keyboard first",
    description:
      "Hit ⌘K / Ctrl+K to jump anywhere, switch contexts or open a terminal. Start typing in any table to filter it, and save in the YAML editor with ⌘S / Ctrl+S.",
    dark: paletteDark,
    light: paletteLight,
  },
  {
    title: "A clearer resource graph",
    description:
      "The resource graph lays out every application in its own group, fits the view on load and no longer gets stuck loading on clusters with duplicate kinds.",
    dark: graphDark,
    light: graphLight,
  },
];

const underTheHood = [
  {
    icon: Gauge,
    title: "Snappier",
    text: "Smarter refreshing that pauses in the background, closed tabs that really stop, and no more duplicate fetches.",
  },
  {
    icon: ShieldCheck,
    title: "Safer",
    text: "A strict content security policy, minimal permissions, and edited manifests are never written to disk.",
  },
  {
    icon: Wrench,
    title: "Fixed",
    text: "Port forwarding works again, copying text works everywhere, and actions always report success or failure.",
  },
  {
    icon: KeyRound,
    title: "SSO friendly",
    text: "Re-login for kubelogin / OIDC and AWS SSO, without exposing tokens.",
  },
  {
    icon: Cpu,
    title: "ARM64 Linux",
    text: "Native builds for aarch64 Linux, next to macOS, Windows and x64 Linux.",
  },
  {
    icon: Laptop,
    title: "Accessible",
    text: "Keyboard-reachable controls, clear focus states and proper labels throughout.",
  },
];
</script>
<template>
  <Carousel :opts="{ loop: true }">
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
            Dozens of fixes and improvements across the whole app.
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
