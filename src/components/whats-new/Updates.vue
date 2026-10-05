<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  BellRing,
  FileCheck2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-vue-next";

import addDark from "@/assets/whats-new/add-cluster-dark.webp";
import addLight from "@/assets/whats-new/add-cluster-light.webp";
import importDark from "@/assets/whats-new/import-preview-dark.webp";
import importLight from "@/assets/whats-new/import-preview-light.webp";
import signInDark from "@/assets/whats-new/sign-in-dark.webp";
import signInLight from "@/assets/whats-new/sign-in-light.webp";
import credentialsDark from "@/assets/whats-new/credentials-dark.webp";
import credentialsLight from "@/assets/whats-new/credentials-light.webp";

const slides = [
  {
    title: "Add any cluster",
    description:
      "Paste a kubeconfig, drop or import a file, or enter an API server with a token or certificate and test it before saving. Press Mod+N anywhere. Clusters you add live in JET Pilot's own kubeconfig; yours stays untouched.",
    dark: addDark,
    light: addLight,
  },
  {
    title: "See what you import",
    description:
      "Before anything is added you see every context, how it signs in and what's wrong with it, which ones you already have, and exactly which commands its sign-in plugins would run.",
    dark: importDark,
    light: importLight,
  },
  {
    title: "Sign in without leaving JET Pilot",
    description:
      "When a token expires, every view says so and one Sign in button does the rest: device codes and browser sign-ins appear right in the app, and lists, logs and port forwards pick up where they left off.",
    dark: signInDark,
    light: signInLight,
  },
  {
    title: "Credentials in your keychain",
    description:
      "Tokens and keys of clusters you add go to your system keychain, or an encrypted file with a passphrase where there's none. A small credential helper makes them work with kubectl in your own terminal too.",
    dark: credentialsDark,
    light: credentialsLight,
  },
];

const underTheHood = [
  {
    icon: ShieldCheck,
    title: "No plain-text secrets",
    text: "JET Pilot's kubeconfig only references credentials; it refuses to write a token or key into it.",
  },
  {
    icon: SquareTerminal,
    title: "Your terminal, too",
    text: "Add ~/.kube/jet-pilot/config to KUBECONFIG, or export clusters into ~/.kube/config (with a backup).",
  },
  {
    icon: BellRing,
    title: "Credential status",
    text: "The Clusters hub shows when credentials expire, so you can sign in before you need to.",
  },
  {
    icon: RefreshCw,
    title: "Sign-in that never surprises",
    text: "Background work never opens a browser: sign-ins only start when you ask for them.",
  },
  {
    icon: FileCheck2,
    title: "Duplicates spotted",
    text: "Importing a cluster you already have? It's unticked and labelled, so nothing is added twice.",
  },
  {
    icon: KeyRound,
    title: "Works without a keychain",
    text: "On systems without one, a passphrase protects the credentials, optionally unlocked for terminals for 12 hours.",
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
            The details behind adding clusters safely.
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
