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
import { Braces, ChartLine, Columns3, Gauge, ShieldCheck, Unplug } from "lucide-vue-next";

import gitopsDark from "@/assets/whats-new/gitops-dark.webp";
import gitopsLight from "@/assets/whats-new/gitops-light.webp";
import usageDark from "@/assets/whats-new/usage-dark.webp";
import usageLight from "@/assets/whats-new/usage-light.webp";
import accessDark from "@/assets/whats-new/access-dark.webp";
import accessLight from "@/assets/whats-new/access-light.webp";
import helmDark from "@/assets/whats-new/helm-dark.webp";
import helmLight from "@/assets/whats-new/helm-light.webp";
import panelsDark from "@/assets/whats-new/panels-dark.webp";
import panelsLight from "@/assets/whats-new/panels-light.webp";
import operatorsDark from "@/assets/whats-new/operators-dark.webp";
import operatorsLight from "@/assets/whats-new/operators-light.webp";
import actionsDark from "@/assets/whats-new/actions-dark.webp";
import actionsLight from "@/assets/whats-new/actions-light.webp";
import portForwardsDark from "@/assets/whats-new/port-forwards-dark.webp";
import portForwardsLight from "@/assets/whats-new/port-forwards-light.webp";

const emit = defineEmits<{ done: [] }>();

const slides = [
  {
    title: "GitOps, at a glance",
    description:
      "One page for every Flux and Argo CD delivery across your clusters, problems first. Open one to see why it's failing and what it delivered, then reconcile, sync or suspend it.",
    dark: gitopsDark,
    light: gitopsLight,
  },
  {
    title: "Usage over time",
    description:
      "The side panel charts CPU and memory over an hour to a week, with requests and limits drawn in. JET Pilot finds your cluster's Prometheus by itself; without one, it shows metrics-server's last 15 minutes.",
    dark: usageDark,
    light: usageLight,
  },
  {
    title: "Access, in plain English",
    description:
      "Ask “Can I delete deployments in payments?” and get a yes or no, with the binding and role behind it. Or ask who can, and see everything a user, group or service account may do.",
    dark: accessDark,
    light: accessLight,
  },
  {
    title: "Helm, built in",
    description:
      "Releases load straight from the cluster, without the helm binary. Each one shows its notes, resources and a history that says what changed. Search charts, then install with a values editor and a preview.",
    dark: helmDark,
    light: helmLight,
  },
  {
    title: "Side panels that explain",
    description:
      "Select anything and the panel says in a sentence whether it's OK, and why not, with links to what it's connected to. Edit labels, annotations and taints in place, with a preview before you save.",
    dark: panelsDark,
    light: panelsLight,
  },
  {
    title: "Your operators, first-class",
    description:
      "cert-manager, Gateway API, Karpenter, KEDA, External Secrets and Prometheus Operator get their own columns, states in words and panels, with actions like Renew and Sync now.",
    dark: operatorsDark,
    light: operatorsLight,
  },
  {
    title: "Your own actions",
    description:
      "Describe an action in a small YAML file: open a URL, run a command, exec, patch or copy. It shows up in row menus, the side panel and the command palette. Find them in Settings › Actions.",
    dark: actionsDark,
    light: actionsLight,
  },
  {
    title: "Port forwards that heal",
    description:
      "Forwards follow their pod through restarts and rollouts, and say quietly when they healed. Send one a request and see the status, headers and body without leaving JET Pilot.",
    dark: portForwardsDark,
    light: portForwardsLight,
  },
];

const underTheHood = [
  {
    icon: Unplug,
    title: "Straight to the API",
    text: "Describe, YAML, browsing Helm releases and port forwards no longer need kubectl or helm.",
  },
  {
    icon: ChartLine,
    title: "Nothing to forward",
    text: "Usage history reaches Prometheus through the API server: no port-forward, no setup.",
  },
  {
    icon: Gauge,
    title: "A faster start",
    text: "A fifth less code loads before the first frame; the side panel and dialogs follow right after.",
  },
  {
    icon: Braces,
    title: "Safe templates",
    text: "Names and labels reach your actions' commands as arguments, never as code.",
  },
  {
    icon: ShieldCheck,
    title: "Guardrails everywhere",
    text: "Sync, reconcile, install, renew and label edits all respect read-only and protected clusters.",
  },
  {
    icon: Columns3,
    title: "Columns for every CRD",
    text: "Any custom resource shows its CRD's own columns, live, with ages and status dots.",
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
        <p class="mt-1 text-sm text-muted-foreground">The details behind 2.2.</p>
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
