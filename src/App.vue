<script setup lang="ts">
import AuthCheck from "./components/AuthCheck.vue";
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import Loading from "@/components/Loading.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import TabProvider from "./providers/TabProvider";
</script>

<template>
  <AppLayout class="dark bg-zinc-900 text-sm rounded-lg">
    <!-- <AuthCheck> -->
    <!-- <template #default> -->
    <Suspense>
      <SettingsContextProvider>
        <KubeContextProvider>
          <TabProvider>
            <CommandPaletteProvider>
              <Navigation />
              <RouterViewport />
              <Toaster />
              <CommandPalette />
            </CommandPaletteProvider>
          </TabProvider>
        </KubeContextProvider>
      </SettingsContextProvider>
    </Suspense>
    <!-- </template> -->
    <!-- <template #loading> -->
    <!-- <Loading label="K8s crew, prepare for take-off..." /> -->
    <!-- </template> -->
    <!-- </AuthCheck> -->
  </AppLayout>
</template>
