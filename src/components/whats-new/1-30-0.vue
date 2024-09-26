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
            src="@/assets/whats-new/helm-basic-support.gif"
            alt="Basic Helm support"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Basic Helm support</h1>
          <p class="text-sm">
            You can now manage Helm releases. Currently only rollbacks and
            deletion are supported. Support for installing and upgrading Helm
            releases will be added in a future version.
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/cluster-resources.gif"
            alt="Cluster Objects"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Support for Cluster Objects</h1>
          <p class="text-sm">
            You can now view and manage cluster resources such as Nodes,
            Namespaces and CRDs.
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/cluster-events.gif"
            alt="Events Support"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Support for Events</h1>
          <p class="text-sm">
            We've added a new Events view that allows you to see all the events
            and the option to navigate to the involved resources quickly.
          </p>
        </div>
      </CarouselItem>
    </CarouselContent>
    <CarouselPrevious />
    <CarouselNext />
  </Carousel>
</template>
