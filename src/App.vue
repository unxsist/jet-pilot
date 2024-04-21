<script setup lang="ts">
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import ColorSchemeProvider from "./providers/ColorSchemeProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import TabProvider from "./providers/TabProvider";
import DialogProvider from "./providers/DialogProvider";
import DialogHandler from "./components/DialogHandler.vue";
</script>

<template>
  <AppLayout
    class="bg-accent text-sm rounded-lg border border-border overflow-hidden"
  >
    <Suspense>
      <SettingsContextProvider>
        <ColorSchemeProvider>
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
        </ColorSchemeProvider>
      </SettingsContextProvider>
    </Suspense>
  </AppLayout>
</template>
