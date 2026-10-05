<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  CloudCog,
  EyeOff,
  FileKey2,
  Radar,
  SquareTerminal,
  TriangleAlert,
} from "lucide-vue-next";

import signInDark from "@/assets/whats-new/aws-sign-in-dark.webp";
import signInLight from "@/assets/whats-new/aws-sign-in-light.webp";
import accountsDark from "@/assets/whats-new/aws-accounts-dark.webp";
import accountsLight from "@/assets/whats-new/aws-accounts-light.webp";
import availableDark from "@/assets/whats-new/available-dark.webp";
import availableLight from "@/assets/whats-new/available-light.webp";
import cloudAccountsDark from "@/assets/whats-new/accounts-dark.webp";
import cloudAccountsLight from "@/assets/whats-new/accounts-light.webp";

const slides = [
  {
    title: "Connect AWS",
    description:
      "Add cluster › Amazon EKS signs you in with IAM Identity Center right in JET Pilot: enter the code, approve in your browser, done. No aws CLI needed, and the aws CLI shares the sign-in.",
    dark: signInDark,
    light: signInLight,
  },
  {
    title: "Every account, every region",
    description:
      "Pick the accounts and the role to use in each, and where to look. JET Pilot finds the EKS clusters in all of them and adds the ones you choose, into a folder if you like.",
    dark: accountsDark,
    light: accountsLight,
  },
  {
    title: "Clusters you haven't added yet",
    description:
      "New clusters in your accounts show up in the Clusters hub as available: add one, add them all, or ignore the ones you don't need. Clusters deleted in AWS are flagged.",
    dark: availableDark,
    light: availableLight,
  },
  {
    title: "Your cloud accounts",
    description:
      "The new Cloud accounts tab shows how each account signs in and until when, what it reaches and its clusters. Sign in again in one click when a session ends.",
    dark: cloudAccountsDark,
    light: cloudAccountsLight,
  },
];

const underTheHood = [
  {
    icon: FileKey2,
    title: "Profiles and keys too",
    text: "Use a profile from ~/.aws/config (MFA included) or an IAM user's access keys, kept in your system keychain.",
  },
  {
    icon: SquareTerminal,
    title: "Works with the aws CLI",
    text: "Signing in also saves the session where the aws CLI looks for it. ~/.aws/config is never changed.",
  },
  {
    icon: Radar,
    title: "Quiet discovery",
    text: "The list refreshes when you open the hub, at most every 30 minutes, and never starts a sign-in.",
  },
  {
    icon: TriangleAlert,
    title: "Gone clusters flagged",
    text: "A cluster deleted in AWS is marked “No longer in AWS” instead of quietly failing.",
  },
  {
    icon: EyeOff,
    title: "Ignore what you don't need",
    text: "Ignored clusters leave the list; Show hidden brings them back.",
  },
  {
    icon: CloudCog,
    title: "Shorter names",
    text: "Clusters added from AWS are called eks-<region>-<name> and shown by their cluster name.",
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
            The details behind connecting AWS.
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
