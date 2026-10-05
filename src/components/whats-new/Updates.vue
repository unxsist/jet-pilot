<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  FlaskConical,
  FolderKanban,
  Gauge,
  Keyboard,
  Plug,
  WifiOff,
} from "lucide-vue-next";

import liveDark from "@/assets/whats-new/live-dark.webp";
import liveLight from "@/assets/whats-new/live-light.webp";
import graphDark from "@/assets/whats-new/graph-dark.webp";
import graphLight from "@/assets/whats-new/graph-light.webp";
import logsDark from "@/assets/whats-new/logs-dark.webp";
import logsLight from "@/assets/whats-new/logs-light.webp";
import editorDark from "@/assets/whats-new/editor-dark.webp";
import editorLight from "@/assets/whats-new/editor-light.webp";
import rolloutsDark from "@/assets/whats-new/rollouts-dark.webp";
import rolloutsLight from "@/assets/whats-new/rollouts-light.webp";
import workspacesDark from "@/assets/whats-new/workspaces-dark.webp";
import workspacesLight from "@/assets/whats-new/workspaces-light.webp";

const slides = [
  {
    title: "Live, and much faster",
    description:
      "Lists now stream changes straight from the Kubernetes API instead of polling kubectl: updates show up in a fraction of a second, revisiting a view is instant, and pod tables show CPU and memory sparklines.",
    dark: liveDark,
    light: liveLight,
  },
  {
    title: "The resource graph, reimagined",
    description:
      "Every app in its own lane, from Ingress to Service to Pods, with config, storage and scaling attached. Health rolls up, missing references stand out, Problems mode zooms to what's broken and clicking a node highlights its whole path.",
    dark: graphDark,
    light: graphLight,
  },
  {
    title: "Logs across every pod",
    description:
      "Open logs on a Deployment, StatefulSet, Job or Service to follow all of its pods at once, colour-coded per pod. Search, filter by pod or container, view previous containers and export — smooth even at thousands of lines per second.",
    dark: logsDark,
    light: logsLight,
  },
  {
    title: "A smarter YAML editor",
    description:
      "Autocompletion, docs and validation from your cluster's own schemas (CRDs included). Saving shows a diff and runs a server-side dry run before anything is applied, and you can compare an object across contexts.",
    dark: editorDark,
    light: editorLight,
  },
  {
    title: "Rollouts, Helm and debugging",
    description:
      "Browse rollout history, diff revisions and roll back safely. Upgrade Helm releases with a values diff, debug pods with an ephemeral container, open a node shell or copy files to and from containers.",
    dark: rolloutsDark,
    light: rolloutsLight,
  },
  {
    title: "Workspaces, split view and more",
    description:
      "Save sets of contexts, namespaces, tabs and port forwards as workspaces, put two tabs side by side, and pick up where you left off — open tabs are restored on start.",
    dark: workspacesDark,
    light: workspacesLight,
  },
];

const underTheHood = [
  {
    icon: Gauge,
    title: "Instant startup",
    text: "The app appears immediately and caches cluster discovery, so navigation is ready right away.",
  },
  {
    icon: Keyboard,
    title: "Keyboard power",
    text: "Navigate tables with the arrow keys, then l for logs, s for shell, e to edit — press ? for all shortcuts.",
  },
  {
    icon: FolderKanban,
    title: "Better tables",
    text: "Reorder, resize and group columns, see CPU and memory history per pod, and filter instantly even at 20,000 rows.",
  },
  {
    icon: Plug,
    title: "Port-forward profiles",
    text: "Save port forwards and start them automatically when JET Pilot launches.",
  },
  {
    icon: WifiOff,
    title: "Works offline",
    text: "The editor no longer loads from a CDN, and secret values never reach the resource graph.",
  },
  {
    icon: FlaskConical,
    title: "Battle-tested",
    text: "Tested against a real Kubernetes API server with thousands of pods, outages and restricted accounts.",
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
