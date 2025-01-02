import { watch, provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import {
  BaseDirectory,
  exists,
  mkdir,
  writeTextFile,
  readTextFile,
} from "@tauri-apps/plugin-fs";
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
    lastKubeConfig: string | null;
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
    pinnedResources: { name: string; kind: string }[];
    appearance: {
      colorScheme: "auto" | "light" | "dark";
    };
    updates: {
      checkOnStartup: boolean;
      whatsNew: string | null;
    };
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
        tabProvider: {
          height: 50,
        },
        shell: {
          executable: "/bin/sh",
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
      },
    });
    provide(SettingsContextStateKey, toRefs(state));

    const save = async () => {
      if (!(await exists(settingsFile, { baseDir: BaseDirectory.AppConfig }))) {
        if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
          await mkdir("", { baseDir: BaseDirectory.AppConfig });
        }
      }

      await writeTextFile(settingsFile, JSON.stringify(state.settings), {
        baseDir: BaseDirectory.AppConfig,
      });
    };

    if (await exists(settingsFile, { baseDir: BaseDirectory.AppConfig })) {
      const fileContents = await readTextFile(settingsFile, {
        baseDir: BaseDirectory.AppConfig,
      });

      // Merge initial state with file contents
      state.settings = { ...state.settings, ...JSON.parse(fileContents) };
    }

    watch(state, (newState) => {
      save();
    });

    if (state.settings.kubeConfigs.length === 0) {
      const home = await homeDir();
      state.settings.kubeConfigs.push(`${home}/.kube/config`);
    }
  },
  render(): any {
    return this.$slots.default();
  },
};
