<script setup lang="ts">
/*
 * The app of a pop-out window (see @/lib/windows): asks the main window
 * what to show, then renders it with the providers its views need. Left
 * out on purpose: the navigation, workspaces, welcome, updates and "What's
 * new" (the main window's), and anything that starts work for the whole
 * app (port-forward auto-start, settings writes).
 */
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as getOsType } from "@tauri-apps/plugin-os";
import AppLayout from "@/components/AppLayout.vue";
import Toaster from "@/components/ui/toast/Toaster.vue";
import { Button } from "@/components/ui/button";
import PopOutSeed from "@/components/popout/PopOutSeed.vue";
import PopOutShell from "@/components/popout/PopOutShell.vue";
import SettingsContextProvider from "@/providers/SettingsContextProvider";
import ThemeProvider from "@/providers/ThemeProvider";
import DialogProvider from "@/providers/DialogProvider";
import KubeContextProvider from "@/providers/KubeContextProvider";
import PortForwardingProvider from "@/providers/PortForwardingProvider";
import PanelProvider from "@/providers/PanelProvider";
import CommandPaletteProvider from "@/providers/CommandPaletteProvider";
import SplitViewProvider from "@/providers/SplitViewProvider";
import { currentWindowLabel, MAIN_WINDOW, type WindowPayload } from "@/lib/windows";
import { parsePayload, WINDOW_EVENTS } from "@/lib/windowRecords";
import { AskAiKey } from "@/lib/ai/askAi";
import { appAskAi } from "@/lib/ai/provider";

const DialogHandler = defineAsyncComponent(() => import("@/components/DialogHandler.vue"));
const GuardrailsHost = defineAsyncComponent(
  () => import("@/components/guardrails/GuardrailsHost.vue")
);
const AuthHost = defineAsyncComponent(() => import("@/components/auth/AuthHost.vue"));
/* Ask AI opens its tabs in this window. */
const AskAiHost = defineAsyncComponent(() => import("@/components/ai/AskAiHost.vue"));
provide(AskAiKey, appAskAi);

const osType = getOsType();
const label = currentWindowLabel();
const current = getCurrentWebviewWindow();

const payload = shallowRef<WindowPayload | null>(null);
/* The main window didn't answer: it no longer knows this window. */
const orphaned = ref(false);

let unlisten: UnlistenFn | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
onMounted(async () => {
  unlisten = await current.listen(WINDOW_EVENTS.payload, ({ payload: value }) => {
    const parsed = parsePayload(value);
    if (parsed && !payload.value) payload.value = parsed;
  });
  await emitTo(MAIN_WINDOW, WINDOW_EVENTS.ready, { label }).catch(() => undefined);
  timer = setTimeout(() => (orphaned.value = !payload.value), 5000);
});
onUnmounted(() => {
  unlisten?.();
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <AppLayout
    class="bg-sidebar text-sm text-foreground rounded-lg border border-border overflow-hidden"
    :class="`os:${osType}`"
  >
    <SettingsContextProvider>
      <template #fallback>
        <div class="h-full w-full" data-tauri-drag-region />
      </template>
      <ThemeProvider>
        <DialogProvider>
          <PopOutSeed v-if="payload" :payload="payload">
            <KubeContextProvider>
              <PortForwardingProvider>
                <PanelProvider :persist="false">
                  <CommandPaletteProvider>
                    <SplitViewProvider>
                      <PopOutShell :label="label" :payload="payload" />
                      <Toaster />
                      <DialogHandler />
                      <GuardrailsHost />
                      <AuthHost />
                      <AskAiHost />
                    </SplitViewProvider>
                  </CommandPaletteProvider>
                </PanelProvider>
              </PortForwardingProvider>
            </KubeContextProvider>
          </PopOutSeed>
          <div
            v-else
            class="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
            data-tauri-drag-region
          >
            <template v-if="orphaned">
              <p>This window is no longer part of JET Pilot.</p>
              <Button variant="outline" size="sm" @click="current.destroy()">Close window</Button>
            </template>
          </div>
        </DialogProvider>
      </ThemeProvider>
    </SettingsContextProvider>
  </AppLayout>
</template>
