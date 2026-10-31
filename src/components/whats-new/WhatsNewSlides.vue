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
import { Bell, HardDrive, Link, ShieldCheck, Sheet, Terminal } from "lucide-vue-next";

import healthDark from "@/assets/whats-new/health-dark.webp";
import healthLight from "@/assets/whats-new/health-light.webp";
import changesDark from "@/assets/whats-new/changes-dark.webp";
import changesLight from "@/assets/whats-new/changes-light.webp";
import upgradesDark from "@/assets/whats-new/upgrades-dark.webp";
import upgradesLight from "@/assets/whats-new/upgrades-light.webp";
import askAiDark from "@/assets/whats-new/ask-ai-dark.webp";
import askAiLight from "@/assets/whats-new/ask-ai-light.webp";
import splitViewDark from "@/assets/whats-new/split-view-dark.webp";
import splitViewLight from "@/assets/whats-new/split-view-light.webp";
import logVolumeDark from "@/assets/whats-new/log-volume-dark.webp";
import logVolumeLight from "@/assets/whats-new/log-volume-light.webp";
import connectionDark from "@/assets/whats-new/connection-dark.webp";
import connectionLight from "@/assets/whats-new/connection-light.webp";

const emit = defineEmits<{ done: [] }>();

const slides = [
  {
    title: "What's broken, in plain words",
    description:
      "The new Health page lists what's broken across your clusters, one row per workload, with the likely cause and the evidence. Fix it with a dry-run diff first, or copy the patch when Helm or GitOps manages it.",
    dark: healthDark,
    light: healthLight,
  },
  {
    title: "What changed, and when",
    description:
      "Image bumps, config edits, scaling, Helm releases and syncs, newest first, with who did it and a diff. Read from the cluster's own history, and recorded while JET Pilot is open.",
    dark: changesDark,
    light: changesLight,
  },
  {
    title: "Ready for the next upgrade",
    description:
      "Support dates for EKS, GKE, AKS and Kubernetes, the deprecated APIs your objects still use and add-ons that need an update. Risks checks limits, probes, budgets and expiring certificates.",
    dark: upgradesDark,
    light: upgradesLight,
  },
  {
    title: "Ask your own AI",
    description:
      "Hand a problem or an object to Claude Code, Codex, Gemini CLI or another agent you use, in a terminal with kubectl pinned to that cluster. Pick one in Settings › AI; JET Pilot sends nothing itself.",
    dark: askAiDark,
    light: askAiLight,
  },
  {
    title: "Two views, side by side",
    description:
      "Alt+click a sidebar item, or press ⌘\\ or Ctrl+\\, to open a view beside the one you're on. Shift+click moves a view or a tab into a window of its own; running shells move without restarting.",
    dark: splitViewDark,
    light: splitViewLight,
  },
  {
    title: "Logs over time",
    description:
      "A slim chart above the logs shows lines over time, with errors and warnings in their colours. Drag across it to read just that moment.",
    dark: logVolumeDark,
    light: logVolumeLight,
  },
  {
    title: "Through the bastion",
    description:
      "Connect a cluster through a SOCKS5 or HTTP proxy, or an SSH jump host. JET Pilot keeps the tunnel open while you use the cluster, and never asks for a password.",
    dark: connectionDark,
    light: connectionLight,
  },
];

const underTheHood = [
  {
    icon: Terminal,
    title: "The kubectl equivalent",
    text: "Confirmations show the kubectl command that does the same; the row menu copies it.",
  },
  {
    icon: Sheet,
    title: "Copy as CSV",
    text: "The selected rows with their visible columns: ⌘⇧C or Ctrl+Shift+C.",
  },
  {
    icon: Link,
    title: "jetpilot:// links",
    text: "Link to an object or a view from Slack or a runbook. Links only navigate.",
  },
  {
    icon: Bell,
    title: "Notify me",
    text: "A desktop notification when a rollout you started finishes or gets stuck.",
  },
  {
    icon: ShieldCheck,
    title: "Drain checks first",
    text: "Disruption budgets, bare pods and emptyDir data, before anything is evicted.",
  },
  {
    icon: HardDrive,
    title: "Stays on your machine",
    text: "Rule data ships with JET Pilot; recorded changes never leave your computer.",
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
        <p class="mt-1 text-sm text-muted-foreground">The details behind 2.3.</p>
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
