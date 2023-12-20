<script setup lang="ts">
import AuthCheck from "./components/AuthCheck.vue";
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import Loading from "@/components/Loading.vue";
import CommandPalette from "./components/CommandPalette.vue";
import KubeContextProvider from "./providers/KubeContextProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
</script>

<template>
  <AppLayout class="dark bg-zinc-900 text-sm rounded-lg">
    <AuthCheck>
      <template #default>
        <KubeContextProvider>
          <CommandPaletteProvider>
            <Navigation />
            <RouterViewport />
            <Toaster />
            <CommandPalette />
          </CommandPaletteProvider>
        </KubeContextProvider>
      </template>
      <template #loading>
        <Loading label="K8s crew, prepare for take-off..." />
      </template>
    </AuthCheck>
  </AppLayout>
</template>
