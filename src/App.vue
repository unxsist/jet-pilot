<script setup lang="ts">
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import TabProvider from "./providers/TabProvider";
import DialogProvider from "./providers/DialogProvider";
import DialogHandler from "./components/DialogHandler.vue";
import Settings from "./views/Settings.vue";
</script>

<template>
  <AppLayout class="dark bg-zinc-900 text-sm rounded-lg overflow-hidden">
    <Suspense>
      <SettingsContextProvider>
        <KubeContextProvider>
          <TabProvider>
            <CommandPaletteProvider>
              <DialogProvider>
                <Navigation />
                <RouterViewport />
                <Toaster />
                <CommandPalette />
                <DialogHandler />
              </DialogProvider>
            </CommandPaletteProvider>
          </TabProvider>
        </KubeContextProvider>
      </SettingsContextProvider>
    </Suspense>
  </AppLayout>
</template>
