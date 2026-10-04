import { watch, provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import {
  BaseDirectory,
  exists,
  mkdir,
  writeTextFile,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { error } from "@/lib/logger";

export const SettingsContextStateKey: InjectionKey<
  ToRefs<SettingsContextState>
> = Symbol("SettingsContextState");

/** Writes pending settings changes to disk immediately (e.g. before quit). */
export const SettingsContextFlushKey: InjectionKey<() => Promise<void>> =
  Symbol("SettingsContextFlush");

/* Coalesce bursts of changes (e.g. resizing the tab panel) into one write. */
const SAVE_DEBOUNCE_MS = 300;

export interface ContextSettings {
  context: string;
  namespaces: string[];
}

export interface SettingsContextState {
  settings: {
    lastKubeConfig: string | null;
    lastContext: string | null;
    lastNamespace: string | null;
    /** Contexts (and their namespaces) activated in the context switcher. */
    activeContexts: { context: string; kubeConfig: string; namespaces: string[] }[];
    PanelProvider: {
      height: number;
    };
    shell: {
      executable: string;
    };
    logs: {
      tail_lines: number;
    };
    kubeConfigs: string[];
    contextSettings: ContextSettings[];
    collapsedNavigationGroups: string[];
    pinnedResources: { name: string; kind: string }[];
    appearance: {
      colorScheme: "auto" | "light" | "dark";
    };
    updates: {
      checkOnStartup: boolean;
      whatsNew: string | null;
    };
    logLevel: "error" | "warn" | "info" | "debug" | "trace";
  };
}

export default {
  name: "SettingsContextProvider",
  async setup() {
    const settingsFile = "settings.json";

    const state: SettingsContextState = reactive({
      settings: {
        lastKubeConfig: null,
        lastContext: null,
        lastNamespace: null,
        activeContexts: [],
        PanelProvider: {
          height: 50,
        },
        shell: {
          executable: "/bin/sh",
        },
        logs: {
          tail_lines: 15,
        },
        kubeConfigs: [],
        contextSettings: [],
        collapsedNavigationGroups: [],
        pinnedResources: [],
        appearance: {
          colorScheme: "auto",
        },
        updates: {
          checkOnStartup: true,
          whatsNew: null,
        },
        logLevel: "error",
      },
    });
    provide(SettingsContextStateKey, toRefs(state));

    let configDirEnsured = false;
    let lastWritten: string | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let writeQueue: Promise<void> = Promise.resolve();

    const write = async (contents: string) => {
      if (contents === lastWritten) {
        return;
      }

      if (!configDirEnsured) {
        if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
          await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
        }
        configDirEnsured = true;
      }

      await writeTextFile(settingsFile, contents, {
        baseDir: BaseDirectory.AppConfig,
      });
      lastWritten = contents;
    };

    /*
     * Writes are serialized: a slow write can never be overtaken by (and
     * overwrite) a newer one. The snapshot is taken when the write is queued.
     */
    const flush = (): Promise<void> => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }

      const contents = JSON.stringify(state.settings);
      writeQueue = writeQueue
        .then(() => write(contents))
        .catch((e) => {
          error(`Failed to save settings: ${e}`);
        });

      return writeQueue;
    };

    const scheduleSave = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    };

    provide(SettingsContextFlushKey, flush);

    if (await exists(settingsFile, { baseDir: BaseDirectory.AppConfig })) {
      const fileContents = await readTextFile(settingsFile, {
        baseDir: BaseDirectory.AppConfig,
      });

      try {
        // Merge initial state with file contents
        state.settings = { ...state.settings, ...JSON.parse(fileContents) };
        lastWritten = fileContents;
      } catch (e) {
        // Keep the unreadable file around before defaults overwrite it.
        error(`Failed to parse settings, using defaults: ${e}`);
        await writeTextFile(`${settingsFile}.corrupt`, fileContents, {
          baseDir: BaseDirectory.AppConfig,
        }).catch(() => {});
      }

      invoke("update_log_level", { level: state.settings.logLevel });
    }

    watch(state, scheduleSave, { deep: true });

    /*
     * Best effort for pending changes when the window goes away; the quit
     * button awaits SettingsContextFlushKey instead.
     */
    window.addEventListener("pagehide", () => {
      if (saveTimer) {
        flush();
      }
    });

    if (state.settings.kubeConfigs.length === 0) {
      const home = await homeDir();
      state.settings.kubeConfigs.push(`${home}/.kube/config`);
    }

    /* Make sure PanelProvider does not open at more than 90% of the screen */
    if (state.settings.PanelProvider.height > 90) {
      state.settings.PanelProvider.height = 90;
    }
  },
  render(): any {
    return this.$slots.default();
  },
};
