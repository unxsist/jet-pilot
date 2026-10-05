<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  Cloud,
  FolderTree,
  Keyboard,
  Palette,
  Settings2,
  TerminalSquare,
} from "lucide-vue-next";

import hubDark from "@/assets/whats-new/hub-dark.webp";
import hubLight from "@/assets/whats-new/hub-light.webp";
import detailsDark from "@/assets/whats-new/cluster-details-dark.webp";
import detailsLight from "@/assets/whats-new/cluster-details-light.webp";
import guardDark from "@/assets/whats-new/guardrails-dark.webp";
import guardLight from "@/assets/whats-new/guardrails-light.webp";
import welcomeDark from "@/assets/whats-new/setup-guide-dark.webp";
import welcomeLight from "@/assets/whats-new/setup-guide-light.webp";

const slides = [
  {
    title: "The Clusters hub",
    description:
      "Every cluster from every kubeconfig in one list: where it runs, its version and nodes, how it signs in, and whether it's reachable right now. Filter with env:prod or provider:aws, group by folder or provider, and connect with Enter. Open it from the sidebar or with Mod+O.",
    dark: hubDark,
    light: hubLight,
  },
  {
    title: "Clusters you recognise",
    description:
      "Give clusters a name and a colour, set their environment, sort them into folders and tag them. The name and colour follow you into the context switcher, tables and a thin bar across the top of the window. Your kubeconfig isn't touched.",
    dark: detailsDark,
    light: detailsLight,
  },
  {
    title: "Guardrails for production",
    description:
      "Mark a cluster as protected and every destructive action asks you to type the resource name, and YAML always goes through a server dry run before it's applied. Read-only clusters hide every change altogether.",
    dark: guardDark,
    light: guardLight,
  },
  {
    title: "A guided start",
    description:
      "New to JET Pilot? A short setup guide shows the kubeconfig files it found, the tools it uses and how it looks. Open it again anytime from the command palette.",
    dark: welcomeDark,
    light: welcomeLight,
  },
];

const underTheHood = [
  {
    icon: Cloud,
    title: "Status without surprises",
    text: "Clusters are checked in the background, but never in a way that opens a sign-in window.",
  },
  {
    icon: FolderTree,
    title: "Favourites and hiding",
    text: "Favourites come first everywhere; hide clusters you never use without editing any file.",
  },
  {
    icon: Keyboard,
    title: "Keyboard first",
    text: "Arrow through the hub, Enter to connect, E to edit, F to favourite, H to hide, / to filter.",
  },
  {
    icon: TerminalSquare,
    title: "Know where you type",
    text: "Terminals on protected and read-only clusters say so before you run anything.",
  },
  {
    icon: Palette,
    title: "Provider marks",
    text: "Clusters show where they run: EKS, GKE, AKS, DigitalOcean, Akamai, Scaleway, local and more.",
  },
  {
    icon: Settings2,
    title: "Namespaces per cluster",
    text: "The namespace lists for clusters where you can't list namespaces now live in each cluster's details.",
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
