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
            src="@/assets/whats-new/mass-actions.gif"
            alt="Object Creation"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Mass actions</h1>
          <p class="text-sm">
            You can now easily perform actions on multiple resources at once,
            for example scale up multiple deployments or kill pods.
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/object-creation.gif"
            alt="Object Creation"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Object Creation</h1>
          <p class="text-sm">
            You can now quickly create new resources by clicking the plus icon
            on a resource overview.
          </p>
        </div>
      </CarouselItem>
      <CarouselItem>
        <div>
          <img
            src="@/assets/whats-new/secret-decoding.gif"
            alt="Object Creation"
            class="w-full rounded-lg"
          />
          <h1 class="font-bold mt-5">Easy secret decoding</h1>
          <p class="text-sm">
            With the new detail view of secrets, you can now easily view the
            contents of the secret. You can decode them and copy them to the
            clipboard.
          </p>
        </div>
      </CarouselItem>
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
