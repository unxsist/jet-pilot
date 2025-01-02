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
            src="@/assets/whats-new/table-filtering.gif"
            alt="Table Filtering"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Resource filtering</h1>
          <p class="text-sm">
            You can now easily filter any resource overview by just starting to
            type in any overview.
          </p>
        </div>
      </CarouselItem>
    </CarouselContent>
    <CarouselPrevious />
    <CarouselNext />
  </Carousel>
</template>
