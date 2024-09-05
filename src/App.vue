<script setup lang="ts">
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import GlobalShortcutProvider from "./providers/GlobalShortcutProvider";
import ColorSchemeProvider from "./providers/ColorSchemeProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import PortForwardingProvider from "./providers/PortForwardingProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import TabProvider from "./providers/TabProvider";
import DialogProvider from "./providers/DialogProvider";
import DialogHandler from "./components/DialogHandler.vue";
import UpdateHandler from "./components/UpdateHandler.vue";
import WhatsNew from "./components/WhatsNew.vue";
import { type as getOsType } from "@tauri-apps/api/os";

const osType = ref("");

onMounted(() => {
  getOsType().then((os) => {
    osType.value = os;
  });
});
</script>

<template>
  <AppLayout
    class="bg-accent text-sm rounded-lg border border-border overflow-hidden"
    :class="`os:${osType}`"
  >
    <Suspense>
      <SettingsContextProvider>
        <GlobalShortcutProvider>
          <ColorSchemeProvider>
            <DialogProvider>
              <KubeContextProvider>
                <PortForwardingProvider>
                  <TabProvider>
                    <CommandPaletteProvider>
                      <Navigation />
                      <RouterViewport />
                      <Toaster />
                      <CommandPalette />
                      <DialogHandler />
                      <UpdateHandler />
                      <WhatsNew />
                    </CommandPaletteProvider>
                  </TabProvider>
                </PortForwardingProvider>
              </KubeContextProvider>
            </DialogProvider>
          </ColorSchemeProvider>
        </GlobalShortcutProvider>
      </SettingsContextProvider>
    </Suspense>
  </AppLayout>
</template>
