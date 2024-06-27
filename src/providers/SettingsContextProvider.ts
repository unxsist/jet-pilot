import { watch, provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import {
  BaseDirectory,
  exists,
  createDir,
  writeTextFile,
  readTextFile,
} from "@tauri-apps/api/fs";
import { homeDir } from "@tauri-apps/api/path";

export const SettingsContextStateKey: InjectionKey<
  ToRefs<SettingsContextState>
> = Symbol("SettingsContextState");

export interface ContextSettings {
  context: string;
  namespaces: string[];
}

export interface SettingsContextState {
  settings: {
    lastContext: string | null;
    lastNamespace: string | null;
    tabProvider: {
      height: number;
    };
    shell: {
      executable: string;
    };
    kubeConfigs: string[];
    contextSettings: ContextSettings[];
    collapsedNavigationGroups: string[];
    appearance: {
      colorScheme: "auto" | "light" | "dark";
    };
    updates: {
      checkOnStartup: boolean;
    };
  };
}

export default {
  name: "SettingsContextProvider",
  async setup() {
    const settingsFile = "settings.json";

    const state: SettingsContextState = reactive({
      settings: {
        lastContext: null,
        lastNamespace: null,
        tabProvider: {
          height: 50,
        },
        shell: {
          executable: "/bin/sh",
        },
        kubeConfigs: [],
        contextSettings: [],
        collapsedNavigationGroups: [],
        appearance: {
          colorScheme: "auto",
        },
        updates: {
          checkOnStartup: true,
        },
      },
    });
    provide(SettingsContextStateKey, toRefs(state));

    const save = async () => {
      if (!(await exists(settingsFile, { dir: BaseDirectory.AppConfig }))) {
        if (!(await exists("", { dir: BaseDirectory.AppConfig }))) {
          await createDir("", { dir: BaseDirectory.AppConfig });
        }
      }

      await writeTextFile(settingsFile, JSON.stringify(state.settings), {
        dir: BaseDirectory.AppConfig,
      });
    };

    if (await exists(settingsFile, { dir: BaseDirectory.AppConfig })) {
      const fileContents = await readTextFile(settingsFile, {
        dir: BaseDirectory.AppConfig,
      });

      // Merge initial state with file contents
      state.settings = { ...state.settings, ...JSON.parse(fileContents) };
    }

    watch(state, (newState) => {
      console.log("Settings changed...", newState);
      save();
    });

    if (state.settings.kubeConfigs.length === 0) {
      const home = await homeDir();
      state.settings.kubeConfigs.push(`${home}.kube/config`);
    }
  },
  render(): any {
    return this.$slots.default();
  },
};
