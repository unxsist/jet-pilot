<script setup lang="ts">
import AppLayout from "@/components/AppLayout.vue";
import Navigation from "@/components/Navigation.vue";
import RouterViewport from "@/components/RouterViewport.vue";
import SidePanel from "@/components/SidePanel.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import CommandPalette from "./components/CommandPalette.vue";
import SettingsContextProvider from "./providers/SettingsContextProvider";
import GlobalShortcutProvider from "./providers/GlobalShortcutProvider";
import ThemeProvider from "./providers/ThemeProvider";
import KubeContextProvider from "./providers/KubeContextProvider";
import PortForwardingProvider from "./providers/PortForwardingProvider";
import CommandPaletteProvider from "./providers/CommandPaletteProvider";
import PanelProvider from "./providers/PanelProvider";
import DialogProvider from "./providers/DialogProvider";
import WorkspaceProvider from "./providers/WorkspaceProvider";
import DialogHandler from "./components/DialogHandler.vue";
import AppSkeleton from "./components/skeletons/AppSkeleton.vue";
import TerminalLauncher from "./components/TerminalLauncher.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { whenIdle } from "@/lib/perf";

const osType = ref(getOsType());

/*
 * Not needed for the first frame: the update check (marked + DOMPurify for
 * the release notes), announcements and "What's new" are loaded once the app
 * is idle.
 */
const UpdateHandler = defineAsyncComponent(
  () => import("./components/UpdateHandler.vue")
);
const AnnouncementHandler = defineAsyncComponent(
  () => import("./components/AnnouncementHandler.vue")
);
const WhatsNew = defineAsyncComponent(
  () => import("./components/WhatsNew.vue")
);
/* Theme palette commands + shortcuts (they come with the theme runtime). */
const ThemeCommands = defineAsyncComponent(
  () => import("./components/ThemeCommands.vue")
);
const idle = ref(false);
onMounted(() => whenIdle(() => (idle.value = true), 2000));
</script>

<template>
  <AppLayout
    class="bg-sidebar text-sm text-foreground rounded-lg border border-border overflow-hidden"
    :class="`os:${osType}`"
  >
    <SettingsContextProvider>
      <template #fallback>
        <AppSkeleton />
      </template>
      <GlobalShortcutProvider>
        <ThemeProvider>
          <DialogProvider>
            <KubeContextProvider>
              <PortForwardingProvider>
                <PanelProvider>
                  <CommandPaletteProvider>
                    <WorkspaceProvider>
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
                      <template v-if="idle">
                        <UpdateHandler />
                        <AnnouncementHandler />
                        <WhatsNew />
                        <ThemeCommands />
                      </template>
                      <TerminalLauncher />
                    </WorkspaceProvider>
                  </CommandPaletteProvider>
                </PanelProvider>
              </PortForwardingProvider>
            </KubeContextProvider>
          </DialogProvider>
        </ThemeProvider>
      </GlobalShortcutProvider>
    </SettingsContextProvider>
  </AppLayout>
</template>
