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
import {
  BellRing,
  FileCheck2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-vue-next";

import signInDark from "@/assets/whats-new/aws-sign-in-dark.webp";
import signInLight from "@/assets/whats-new/aws-sign-in-light.webp";
import accountsPickDark from "@/assets/whats-new/aws-accounts-dark.webp";
import accountsPickLight from "@/assets/whats-new/aws-accounts-light.webp";
import availableDark from "@/assets/whats-new/available-dark.webp";
import availableLight from "@/assets/whats-new/available-light.webp";
import accountsDark from "@/assets/whats-new/accounts-dark.webp";
import accountsLight from "@/assets/whats-new/accounts-light.webp";

const emit = defineEmits<{ done: [] }>();

const slides = [
  {
    title: "Connect AWS",
    description:
      "Sign in with IAM Identity Center, an AWS profile (MFA included) or access keys. The device code appears right in the app.",
    dark: signInDark,
    light: signInLight,
  },
  {
    title: "Every account and region",
    description:
      "Choose the accounts, the role to use in each and the regions. JET Pilot finds the EKS clusters as it goes, and you pick the ones to add.",
    dark: accountsPickDark,
    light: accountsPickLight,
  },
  {
    title: "New clusters, as they appear",
    description:
      "Clusters in your accounts that aren't added yet wait in the Clusters hub: add one, add them all, or ignore the rest. Clusters deleted in AWS are flagged.",
    dark: availableDark,
    light: availableLight,
  },
  {
    title: "Cloud accounts at a glance",
    description:
      "How each account signs in and until when, what it reaches and its clusters, with sign in again and look for new clusters one click away.",
    dark: accountsDark,
    light: accountsLight,
  },
];

const underTheHood = [
  {
    icon: ShieldCheck,
    title: "Keys stay in your keychain",
    text: "Access keys are checked with AWS and stored in the keychain, never in a kubeconfig.",
  },
  {
    icon: SquareTerminal,
    title: "Your terminal, too",
    text: "Added clusters sign in through jetpilot-auth, so kubectl and k9s use them as they are.",
  },
  {
    icon: KeyRound,
    title: "One sign-in for the aws CLI",
    text: "Signing in also fills the standard SSO cache: aws commands for that portal just work.",
  },
  {
    icon: RefreshCw,
    title: "Quiet by default",
    text: "The list refreshes when the hub opens, at most every 30 minutes, and never starts a sign-in.",
  },
  {
    icon: BellRing,
    title: "Removed clusters flagged",
    text: "A cluster deleted in AWS is marked “No longer in AWS” instead of failing quietly.",
  },
  {
    icon: FileCheck2,
    title: "Your AWS config untouched",
    text: "JET Pilot reads your AWS profiles but never changes ~/.aws/config.",
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
