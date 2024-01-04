import { watch, provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import {
  BaseDirectory,
  exists,
  createDir,
  writeTextFile,
  readTextFile,
} from "@tauri-apps/api/fs";

export const SettingsContextStateKey: InjectionKey<
  ToRefs<SettingsContextState>
> = Symbol("SettingsContextState");

export interface SettingsContextState {
  settings: {
    lastContext: string | null;
    lastNamespace: string | null;
    tabProvider: {
      height: number;
    };
  };
}

export default {
  async setup() {
    const settingsFile = "settings.json";

    const state: SettingsContextState = reactive({
      settings: {
        lastContext: null,
        lastNamespace: null,
        tabProvider: {
          height: 50,
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
      save();
    });
  },
  render(): any {
    return this.$slots.default();
  },
};
