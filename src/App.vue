<script setup lang="ts">
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import SidePanel from "@/components/SidePanel.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import GlobalShortcutProvider from "./providers/GlobalShortcutProvider";
import ColorSchemeProvider from "./providers/ColorSchemeProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import PortForwardingProvider from "./providers/PortForwardingProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import PanelProvider from "./providers/PanelProvider";
import DialogProvider from "./providers/DialogProvider";
import DialogHandler from "./components/DialogHandler.vue";
import UpdateHandler from "./components/UpdateHandler.vue";
import WhatsNew from "./components/WhatsNew.vue";
import TerminalLauncher from "./components/TerminalLauncher.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type as getOsType } from "@tauri-apps/plugin-os";

const osType = ref(getOsType());
</script>

<template>
  <AppLayout
    class="bg-sidebar text-sm text-foreground rounded-lg border border-border overflow-hidden"
    :class="`os:${osType}`"
  >
    <Suspense>
      <SettingsContextProvider>
        <GlobalShortcutProvider>
          <ColorSchemeProvider>
            <DialogProvider>
              <KubeContextProvider>
                <PortForwardingProvider>
                  <PanelProvider>
                    <CommandPaletteProvider>
                      <Navigation />
                      <!--
                        Content sits on an inset canvas: the app chrome
                        (sidebar colour) frames it on the right, top and
                        bottom. The gutter is a window drag region.
                      -->
                      <div
                        class="flex min-w-0 flex-1 py-1.5 pr-1.5"
                        data-tauri-drag-region
                      >
                        <div
                          class="flex min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs"
                        >
                          <ResizablePanelGroup direction="horizontal">
                            <ResizablePanel><RouterViewport /></ResizablePanel>
                            <ResizableHandle />
                            <SidePanel />
                          </ResizablePanelGroup>
                        </div>
                      </div>
                      <Toaster />
                      <CommandPalette />
                      <DialogHandler />
                      <UpdateHandler />
                      <WhatsNew />
                      <TerminalLauncher />
                    </CommandPaletteProvider>
                  </PanelProvider>
                </PortForwardingProvider>
              </KubeContextProvider>
            </DialogProvider>
          </ColorSchemeProvider>
        </GlobalShortcutProvider>
      </SettingsContextProvider>
    </Suspense>
  </AppLayout>
</template>
