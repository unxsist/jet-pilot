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
import { Cloud, KeyRound, LayoutDashboard, Search, ShieldCheck, SquareTerminal } from "lucide-vue-next";

import hubDark from "@/assets/whats-new/hub-dark.webp";
import hubLight from "@/assets/whats-new/hub-light.webp";
import cloudsDark from "@/assets/whats-new/clouds-dark.webp";
import cloudsLight from "@/assets/whats-new/clouds-light.webp";
import signInDark from "@/assets/whats-new/sign-in-dark.webp";
import signInLight from "@/assets/whats-new/sign-in-light.webp";
import guardrailsDark from "@/assets/whats-new/guardrails-dark.webp";
import guardrailsLight from "@/assets/whats-new/guardrails-light.webp";
import settingsDark from "@/assets/whats-new/settings-dark.webp";
import settingsLight from "@/assets/whats-new/settings-light.webp";

const emit = defineEmits<{ done: [] }>();

const slides = [
  {
    title: "Welcome to JET Pilot 2.0",
    description:
      "The Clusters hub has every cluster from every kubeconfig and cloud account in one calm list. Name them, colour them, put them in folders; click one for everything about it.",
    dark: hubDark,
    light: hubLight,
  },
  {
    title: "Every cloud, connected",
    description:
      "Add cluster connects AWS, Google Cloud, Azure, DigitalOcean, Akamai, Civo, Scaleway, Vultr and Exoscale, finds their clusters and keeps the list current. Or paste, import or enter a cluster by hand.",
    dark: cloudsDark,
    light: cloudsLight,
  },
  {
    title: "Sign in without leaving JET Pilot",
    description:
      "Device codes and browser sign-ins appear right in the app, and every view reconnects when you're done. Credentials live in your system keychain, never in plain text.",
    dark: signInDark,
    light: signInLight,
  },
  {
    title: "Production, protected",
    description:
      "Mark a cluster as production and deleting or scaling to zero asks you to type the name. Read-only clusters can't be changed from JET Pilot at all.",
    dark: guardrailsDark,
    light: guardrailsLight,
  },
  {
    title: "Settings, rebuilt",
    description:
      "Every setting is searchable (⌘, or Ctrl+,), the ones you changed are marked, and settings.json is there if you prefer text.",
    dark: settingsDark,
    light: settingsLight,
  },
];

const underTheHood = [
  {
    icon: SquareTerminal,
    title: "Your terminal, too",
    text: "Clusters you add work in kubectl and k9s through a small credential helper.",
  },
  {
    icon: KeyRound,
    title: "Your kubeconfig untouched",
    text: "Added clusters live in ~/.kube/jet-pilot/config; export them when you want them elsewhere.",
  },
  {
    icon: Cloud,
    title: "Quiet discovery",
    text: "Cloud accounts are checked when the hub opens and never start a sign-in by themselves.",
  },
  {
    icon: ShieldCheck,
    title: "Calmer everywhere",
    text: "A design pass over the whole app: fewer boxes, clearer lists, status only when it needs you.",
  },
  {
    icon: LayoutDashboard,
    title: "A setup guide",
    text: "New installs get a short guide; open it any time from the command palette.",
  },
  {
    icon: Search,
    title: "Found automatically",
    text: "~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d are picked up by themselves.",
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
        <p class="mt-1 text-sm text-muted-foreground">The details behind 2.0.</p>
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
