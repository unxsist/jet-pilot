import {
  watch,
  provide,
  reactive,
  ref,
  InjectionKey,
  Ref,
  SetupContext,
  toRefs,
  ToRefs,
} from "vue";
import {
  BaseDirectory,
  exists,
  mkdir,
  writeTextFile,
  readTextFile,
  watch as watchFs,
} from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { error, warn } from "@/lib/logger";
import { perfMark } from "@/lib/perf";
import { setRuntimeSettings } from "@/lib/settings/runtime";
import type { Settings, SettingsIssue } from "@/lib/settings/types";
import type { JsonObject } from "@/lib/settings/paths";

export type { ContextSettings, Settings } from "@/lib/settings/types";

export const SettingsContextStateKey: InjectionKey<
  ToRefs<SettingsContextState>
> = Symbol("SettingsContextState");

/** Writes pending settings changes to disk immediately (e.g. before quit). */
export const SettingsContextFlushKey: InjectionKey<() => Promise<void>> =
  Symbol("SettingsContextFlush");

/** Whether settings.json has been read (the real app tree is rendered). */
export const SettingsContextReadyKey: InjectionKey<Readonly<Ref<boolean>>> =
  Symbol("SettingsContextReady");

/** settings.json as a document: the settings UI, its JSON editor and imports. */
export interface SettingsFileApi {
  /** The settings.json text for the current preferences. */
  preferencesText(): string;
  /**
   * Replaces the preferences with those of a settings.json document
   * (missing keys: defaults). Returns the values that were ignored.
   */
  applyPreferences(document: unknown): SettingsIssue[];
  /** Every preference back to its default. */
  resetPreferences(): void;
  /** Values ignored when settings.json was last read. */
  issues: Readonly<Ref<SettingsIssue[]>>;
}

export const SettingsFileApiKey: InjectionKey<SettingsFileApi> =
  Symbol("SettingsFileApi");

/** No settings existed when the app started: a fresh install (the welcome shows). */
export const SettingsFirstRunKey: InjectionKey<Readonly<Ref<boolean>>> =
  Symbol("SettingsFirstRun");

/* Coalesce bursts of changes (e.g. resizing the tab panel) into one write. */
const SAVE_DEBOUNCE_MS = 300;

export interface SettingsContextState {
  settings: Settings;
}

type Store = typeof import("@/lib/settings/store");

/*
 * One settings file: read once, written serialized (a slow write is never
 * overtaken by an older one) and only when its content changed. When the
 * file exists but can't be read or parsed, it is never overwritten unless a
 * backup could be made first.
 */
function jsonFile(name: string) {
  const file = {
    name,
    lastText: null as string | null,
    canSave: false,
    queue: Promise.resolve(),

    /** The parsed file; undefined when it doesn't exist (or was unusable). */
    async read(): Promise<{ text: string | null; data: unknown }> {
      if (!(await exists(name, { baseDir: BaseDirectory.AppConfig }))) {
        file.canSave = true;
        return { text: null, data: undefined };
      }
      // A read failure throws: saving stays disabled, the file is kept.
      const text = await readTextFile(name, { baseDir: BaseDirectory.AppConfig });
      try {
        const data = JSON.parse(text);
        file.lastText = text;
        file.canSave = true;
        return { text, data };
      } catch (e) {
        error(`Failed to parse ${name}, using defaults: ${e}`);
        file.canSave = await writeTextFile(`${name}.corrupt`, text, {
          baseDir: BaseDirectory.AppConfig,
        }).then(
          () => true,
          (backupError) => {
            error(`Failed to back up unreadable ${name}, not saving it: ${backupError}`);
            return false;
          }
        );
        return { text, data: undefined };
      }
    },

    write(text: string): Promise<void> {
      if (!file.canSave || text === file.lastText) return file.queue;
      file.queue = file.queue
        .then(async () => {
          if (text === file.lastText) return;
          await ensureConfigDir();
          await writeTextFile(name, text, { baseDir: BaseDirectory.AppConfig });
          file.lastText = text;
        })
        .catch((e) => error(`Failed to save ${name}: ${e}`));
      return file.queue;
    },
  };
  return file;
}

let configDirEnsured = false;
const ensureConfigDir = async () => {
  if (configDirEnsured) return;
  if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
    await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
  }
  configDirEnsured = true;
};

export default {
  name: "SettingsContextProvider",
  /*
   * Synchronous on purpose: the app shell must not wait (behind a
   * <Suspense>) for the settings files. Until they are read the `fallback`
   * slot (the app skeleton) is rendered, so nothing below this provider ever
   * sees incomplete settings.
   *
   * Preferences live in settings.json (sparse: only values that differ from
   * their default, see src/lib/settings/store.ts), session state in
   * state.json. The preference registry is loaded while the files are read.
   */
  setup(_props: unknown, { slots }: SetupContext) {
    const state: SettingsContextState = reactive({
      settings: {} as Settings,
    });
    provide(SettingsContextStateKey, toRefs(state));

    const settingsFile = jsonFile("settings.json");
    // Session state (src/lib/settings/state.ts).
    const stateFile = jsonFile("state.json");
    let store: Store | null = null;
    /* Keys of settings.json this release doesn't know (written back as they were). */
    let extras: JsonObject = {};
    const issues = ref<SettingsIssue[]>([]);

    const preferencesText = () =>
      store ? store.serializeJson(store.preferencesFile(state.settings, extras)) : "";

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): Promise<void> => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!store) return Promise.resolve();
      return Promise.all([
        settingsFile.write(preferencesText()),
        stateFile.write(store.serializeJson(store.stateFile(state.settings))),
      ]).then(() => undefined);
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    };
    provide(SettingsContextFlushKey, flush);

    const applyPreferences = (document: unknown): SettingsIssue[] => {
      if (!store) return [];
      const applied = store.applyPreferences(state.settings, document);
      extras = applied.extras;
      scheduleSave();
      return applied.issues;
    };

    provide(SettingsFileApiKey, {
      preferencesText,
      applyPreferences,
      resetPreferences: () => void applyPreferences({}),
      issues,
    });

    const syncLogLevel = () =>
      invoke("update_log_level", { level: state.settings.diagnostics.logLevel }).catch((e) =>
        error(`Failed to set the log level: ${e}`)
      );

    const ready = ref(false);
    provide(SettingsContextReadyKey, ready);
    const firstRun = ref(false);
    provide(SettingsFirstRunKey, firstRun);

    const load = async () => {
      const [loadedStore, settingsRead, stateRead, home] = await Promise.all([
        import("@/lib/settings/store"),
        settingsFile.read(),
        stateFile.read(),
        homeDir().catch(() => undefined),
      ]);
      store = loadedStore;
      firstRun.value = settingsRead.text === null && stateRead.text === null;

      const migrated = store.migrate(settingsRead.data, stateRead.data, { home });
      if (migrated.changed && settingsRead.text !== null) {
        // The first migration keeps the original file around.
        const backup = store.SETTINGS_BACKUP_FILE;
        if (!(await exists(backup, { baseDir: BaseDirectory.AppConfig }).catch(() => true))) {
          await writeTextFile(backup, settingsRead.text, { baseDir: BaseDirectory.AppConfig }).catch(
            (e) => warn(`Failed to back up the settings before migrating them: ${e}`)
          );
        }
      }

      const sanitized = store.sanitizePreferences(migrated.preferences);
      extras = sanitized.extras;
      issues.value = sanitized.issues;
      for (const issue of sanitized.issues) {
        warn(`Ignored setting ${issue.key} in settings.json: ${issue.message}`);
      }

      const settings = store.buildSettings(sanitized.values, migrated.state);
      /* Make sure PanelProvider does not open at more than 90% of the screen */
      if (settings.PanelProvider.height > 90) settings.PanelProvider.height = 90;
      state.settings = settings;

      if (settingsRead.text !== null) syncLogLevel();
    };

    /* Edits made outside the app (an editor, a dotfiles sync) apply live. */
    const watchSettingsFile = async () => {
      try {
        await watchFs(
          settingsFile.name,
          async () => {
            const text = await readTextFile(settingsFile.name, {
              baseDir: BaseDirectory.AppConfig,
            }).catch(() => null);
            if (text === null || text === settingsFile.lastText) return;
            try {
              issues.value = applyPreferences(JSON.parse(text));
              // Keep the file as the user wrote it (no normalising rewrite).
              settingsFile.lastText = preferencesText();
            } catch (e) {
              warn(`settings.json changed but isn't valid JSON, ignoring it: ${e}`);
            }
          },
          { baseDir: BaseDirectory.AppConfig, delayMs: 200 }
        );
      } catch (e) {
        warn(`settings.json is not watched for changes: ${e}`);
      }
    };

    load()
      .catch((e) => {
        error(`Failed to load settings, using defaults (changes are not saved): ${e}`);
        // Never replace files that exist but couldn't be loaded with defaults.
        settingsFile.canSave = false;
        stateFile.canSave = false;
        return import("@/lib/settings/store").then((loadedStore) => {
          store = loadedStore;
          state.settings = loadedStore.buildSettings(loadedStore.sanitizePreferences({}).values, {});
        });
      })
      .finally(() => {
        setRuntimeSettings(() => state.settings);
        // Only start saving now: an earlier save would overwrite the files
        // with defaults. Persist what loading filled in (no-op if unchanged).
        watch(() => state.settings, scheduleSave, { deep: true });
        watch(() => state.settings.diagnostics?.logLevel, syncLogLevel);
        // The credential broker is on in the backend unless turned off here.
        watch(
          () => state.settings.auth?.credentialBroker,
          (enabled, previous) => {
            if (enabled === false || previous === false) {
              invoke("auth_set_broker", { enabled: enabled !== false }).catch((e) =>
                error(`Failed to switch the credential broker: ${e}`)
              );
            }
          },
          { immediate: true }
        );
        flush().then(() => {
          if (settingsFile.canSave) void watchSettingsFile();
        });
        ready.value = true;
        perfMark("settings:loaded");
      });

    /*
     * Best effort for pending changes when the window goes away; the quit
     * button awaits SettingsContextFlushKey instead.
     */
    window.addEventListener("pagehide", () => {
      if (saveTimer) {
        flush();
      }
    });

    return () => (ready.value ? slots.default?.() : slots.fallback?.());
  },
};
