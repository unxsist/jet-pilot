<script setup lang="ts">
/*
 * The What's New slides: a screenshot per feature with a title and one
 * short paragraph, then the details "under the hood". Dots and Back / Next
 * at the bottom; the last slide's button closes the dialog.
 */
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import type { UnwrapRefCarouselApi } from "@/components/ui/carousel/interface";
import { Button } from "@/components/ui/button";
import { Download, FileCheck2, KeyRound, RefreshCw, ShieldCheck, SquareTerminal } from "lucide-vue-next";

import cloudsDark from "@/assets/whats-new/clouds-dark.webp";
import cloudsLight from "@/assets/whats-new/clouds-light.webp";
import gcpDark from "@/assets/whats-new/gcp-dark.webp";
import gcpLight from "@/assets/whats-new/gcp-light.webp";
import tokenDark from "@/assets/whats-new/token-dark.webp";
import tokenLight from "@/assets/whats-new/token-light.webp";
import accountsDark from "@/assets/whats-new/all-accounts-dark.webp";
import accountsLight from "@/assets/whats-new/all-accounts-light.webp";

const emit = defineEmits<{ done: [] }>();

const slides = [
  {
    title: "Every cloud",
    description:
      "Add cluster now connects AWS, Google Cloud, Azure, DigitalOcean, Akamai, Civo, Scaleway, Vultr and Exoscale. JET Pilot finds the clusters and keeps the list current.",
    dark: cloudsDark,
    light: cloudsLight,
  },
  {
    title: "Google Cloud and Azure, through their CLIs",
    description:
      "Use the gcloud or az sign-in you already have, or sign in right in the app. Pick the projects or subscriptions, then the clusters.",
    dark: gcpDark,
    light: gcpLight,
  },
  {
    title: "A token is all it takes",
    description:
      "DigitalOcean, Akamai, Civo, Scaleway and Vultr connect with an API token, Exoscale with an API key. They go to your keychain, never into a kubeconfig.",
    dark: tokenDark,
    light: tokenLight,
  },
  {
    title: "All your clouds in one place",
    description:
      "The Cloud accounts tab shows every account, how it signs in and what it reaches. New clusters in any of them wait in the Clusters hub.",
    dark: accountsDark,
    light: accountsLight,
  },
];

const underTheHood = [
  {
    icon: SquareTerminal,
    title: "Standard plugins",
    text: "GKE clusters sign in with gke-gcloud-auth-plugin and AKS with kubelogin, so kubectl and k9s use them as they are.",
  },
  {
    icon: Download,
    title: "kubelogin, verified",
    text: "No kubelogin? JET Pilot downloads it from Azure's releases and checks its checksum.",
  },
  {
    icon: KeyRound,
    title: "Short-lived credentials",
    text: "DigitalOcean tokens and Exoscale certificates are minted when needed and expire on their own.",
  },
  {
    icon: ShieldCheck,
    title: "Exoscale access, your call",
    text: "Certificates are for system:masters by default; change the user and groups per account.",
  },
  {
    icon: FileCheck2,
    title: "Your CLI config untouched",
    text: "JET Pilot reads gcloud, az and doctl but never changes their configuration.",
  },
  {
    icon: RefreshCw,
    title: "Quiet by default",
    text: "Accounts are checked when the hub opens, at most every 30 minutes, and never start a sign-in.",
  },
];

const count = slides.length + 1;
const api = shallowRef<UnwrapRefCarouselApi>();
const selected = ref(0);
const onApi = (value: UnwrapRefCarouselApi) => {
  api.value = value;
  value?.on("select", () => (selected.value = value.selectedScrollSnap()));
};
const last = computed(() => selected.value === count - 1);
</script>
<template>
  <Carousel class="min-w-0 px-0" @init-api="onApi">
    <CarouselContent class="ml-0">
      <CarouselItem v-for="slide in slides" :key="slide.title" class="px-6">
        <img
          :src="slide.dark"
          :alt="slide.title"
          class="hidden w-full rounded-lg border shadow-xs dark:block"
          style="aspect-ratio: 16 / 10"
        />
        <img
          :src="slide.light"
          :alt="slide.title"
          class="w-full rounded-lg border shadow-xs dark:hidden"
          style="aspect-ratio: 16 / 10"
        />
        <h3 class="mt-4 text-lg font-semibold">{{ slide.title }}</h3>
        <p class="mt-1 text-sm text-muted-foreground">{{ slide.description }}</p>
      </CarouselItem>
      <CarouselItem class="px-6">
        <h3 class="text-lg font-semibold">Under the hood</h3>
        <p class="mt-1 text-sm text-muted-foreground">The details that keep your accounts safe.</p>
        <ul class="mt-4 grid grid-cols-2 gap-x-8 gap-y-5">
          <li v-for="item in underTheHood" :key="item.title" class="flex gap-3">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <component :is="item.icon" class="h-4 w-4" />
            </span>
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ item.title }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ item.text }}</p>
            </div>
          </li>
        </ul>
      </CarouselItem>
    </CarouselContent>

    <div class="flex items-center justify-between p-6">
      <div class="flex items-center gap-1.5" role="group" aria-label="Slides">
        <button
          v-for="index in count"
          :key="index"
          type="button"
          class="h-1.5 rounded-full transition-all duration-base focus-ring"
          :class="selected === index - 1 ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/30'"
          :aria-label="`Slide ${index} of ${count}`"
          :aria-current="selected === index - 1 ? 'step' : undefined"
          @click="api?.scrollTo(index - 1)"
        />
      </div>
      <div class="flex items-center gap-2">
        <Button v-if="selected > 0" variant="ghost" @click="api?.scrollPrev()">Back</Button>
        <Button @click="last ? emit('done') : api?.scrollNext()">
          {{ last ? "Done" : "Next" }}
        </Button>
      </div>
    </div>
  </Carousel>
</template>
