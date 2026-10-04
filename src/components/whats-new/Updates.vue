<script setup lang="ts">
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
</script>
<template>
  <Carousel :opts="{ loop: true }">
    <CarouselContent>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/resource-graph.gif"
            alt="Resource Graph"
            class="w-full rounded-lg border shadow-xs"
          />
          <h3 class="mt-4 text-base font-semibold">Resource Graph</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            Get a high level overview of all objects deployed in a namespace and
            easily identify dependencies between objects.
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/detail-pane.gif"
            alt="Object Details Pane"
            class="w-full rounded-lg border shadow-xs"
          />
          <h3 class="mt-4 text-base font-semibold">Objects Detail Pane</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            We've added a Object Detail pane that can be openen by left-clicking
            on any resource. For now, for most objects, it shows generic
            information like labels and metadata, but this will be enriched in
            later versions.
          </p>
        </div>
      </CarouselItem>
    </CarouselContent>
    <CarouselPrevious />
    <CarouselNext />
  </Carousel>
</template>
