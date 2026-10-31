import { provide, onUnmounted, type SetupContext } from "vue";
import { useRouter } from "vue-router";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { exit } from "@tauri-apps/plugin-process";
import { injectStrict } from "@/lib/utils";
import { whenIdle } from "@/lib/perf";
import {
  SettingsContextFlushKey,
  SettingsContextStateKey,
} from "@/providers/SettingsContextProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import {
  PanelProviderSessionKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";
import { SplitViewKey } from "@/providers/SplitViewProvider";
import { beginQuit, QUIT_REQUESTED_EVENT, WindowsKey } from "@/lib/windows";
import type { WindowsHost } from "@/lib/windowsHost";

/**
 * Pop-out windows, main window side (see @/lib/windows). The work lives in
 * @/lib/windowsHost, loaded once the app has settled (it reopens the
 * windows of the last session and adds the palette commands) or when a
 * window opens before that. Closing the main window quits the app, pop-out
 * windows included.
 */
export default {
  name: "WindowsProvider",
  setup(_props: unknown, { slots }: SetupContext) {
    const router = useRouter();
    const { settings } = injectStrict(SettingsContextStateKey);
    const flushSettings = injectStrict(SettingsContextFlushKey);
    const { contexts, contextKubeConfigMapping, context } = injectStrict(KubeContextStateKey);
    const { tabs, activeTabId } = injectStrict(PanelProviderStateKey);
    const panel = injectStrict(PanelProviderSessionKey);
    const split = injectStrict(SplitViewKey);
    const registerCommand = injectStrict(RegisterCommandStateKey);

    let host: Promise<WindowsHost> | null = null;
    const load = () =>
      (host ??= import("@/lib/windowsHost").then(({ createWindowsHost }) =>
        createWindowsHost({
          router,
          settings,
          context,
          contexts,
          contextKubeConfigMapping,
          tabs,
          activeTabId,
          panel,
          split,
          registerCommand,
        })
      ));

    provide(WindowsKey, {
      openView: async (path, options) => (await load()).openView(path, options),
      moveTab: async (tabId) => (await load()).moveTab(tabId),
      canMoveTab: (tabId) => !!panel.describe(tabId),
    });

    whenIdle(() => void load());

    /* The OS close button (or Cmd+W) on the main window: quit, settings saved first. */
    const quitListener = getCurrentWebviewWindow()
      .listen(QUIT_REQUESTED_EVENT, async () => {
        beginQuit();
        await flushSettings().catch(() => undefined);
        await exit(0);
      })
      .catch(() => null);

    onUnmounted(() => {
      void quitListener.then((unlisten) => unlisten?.());
      void host?.then((h) => h.dispose());
    });

    return () => slots.default?.();
  },
};
