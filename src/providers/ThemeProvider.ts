import {
  computed,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  watch,
  type InjectionKey,
  type SetupContext,
} from "vue";
import { useColorMode, usePreferredDark } from "@vueuse/core";
import { invoke } from "@tauri-apps/api/core";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { error as logError } from "@/lib/logger";
import { whenIdle } from "@/lib/perf";
import {
  COLOR_SCHEME_KEY,
  THEME_CACHE_KEY,
  wantedAppearance,
} from "@/lib/themes/scheme";
import type {
  ColorScheme,
  ResolvedTheme,
  ThemeAppearance,
  ThemeContext,
  ThemeEntry,
} from "@/lib/themes/types";
import type { ThemeRuntime } from "./ThemeRuntime";

export const ThemeContextKey: InjectionKey<ThemeContext> = Symbol("ThemeContext");

/** The app theme: see ThemeContext in src/lib/themes/types.ts. */
export const useTheme = () => injectStrict(ThemeContextKey);

const JET = "jet";

/**
 * Paints the app theme and provides `useTheme()`.
 *
 * - JET is painted by main.postcss: only the `.dark` / `.light` class
 *   (VueUse useColorMode), no inline variables. That is all this module
 *   does by itself, so the startup bundle stays small.
 * - Everything else (the theme list, the themes folder with hot reload,
 *   resolution, previews, the first-paint cache) is ./ThemeRuntime.ts, a
 *   lazy chunk loaded once the app is idle, or right away when a theme
 *   other than JET is needed. Themes other than JET are written as inline
 *   custom properties on <html> (`--background: 240 5% 6.5%`).
 * - public/boot.js paints the cached result (`jet-theme-cache`) before the
 *   first frame, so a custom theme doesn't flash JET at start-up.
 */
export default {
  name: "ThemeProvider",
  setup(_props: unknown, { slots }: SetupContext) {
    const { settings } = injectStrict(SettingsContextStateKey);
    const appearanceSettings = () => settings.value.appearance;
    const root = document.documentElement;

    const systemDark = usePreferredDark();
    const wanted = computed(() =>
      wantedAppearance(appearanceSettings().colorScheme, systemDark.value)
    );

    // public/boot.js reads the scheme to pick the cached appearance.
    const store = (key: string, value: string) => {
      try {
        if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    };
    watch(() => appearanceSettings().colorScheme, (scheme) => store(COLOR_SCHEME_KEY, scheme), {
      immediate: true,
    });

    /*
     * The painted appearance (boot.js set the class already). VueUse keeps
     * the `.dark` / `.light` class on <html> in sync with it, so the `dark:`
     * variants follow the painted theme (a dark-only theme in light mode
     * paints dark).
     */
    const painted = ref<ThemeAppearance>(root.classList.contains("dark") ? "dark" : "light");
    useColorMode({ storageKey: null, storageRef: painted });

    /* undefined: unknown (boot.js may have written variables). */
    let paintedVars: Record<string, string> | null | undefined;
    const paint = (
      appearance: ThemeAppearance,
      vars: Record<string, string> | null,
      id: string | null
    ) => {
      if (vars !== paintedVars) {
        // Like VueUse's class switch: no colour transitions while repainting.
        const style = document.createElement("style");
        style.textContent = "*,*::before,*::after{transition:none!important}";
        document.head.appendChild(style);
        for (let i = root.style.length - 1; i >= 0; i--) {
          if (root.style[i].startsWith("--")) root.style.removeProperty(root.style[i]);
        }
        for (const [token, value] of Object.entries(vars ?? {})) {
          root.style.setProperty(`--${token}`, value);
        }
        if (id) root.dataset.themeId = id;
        else delete root.dataset.themeId;
        void window.getComputedStyle(style).opacity; // forces the style before removing it
        style.remove();
        paintedVars = vars;
      }
      painted.value = appearance;
    };

    const themes = shallowRef<ThemeEntry[]>([]);
    const active = shallowRef<ResolvedTheme | null>(null);
    const activeId = ref(JET);
    const previewing = ref(false);

    let runtime: Promise<ThemeRuntime> | null = null;
    let loaded: ThemeRuntime | null = null;
    let unmounted = false;
    const load = (): Promise<ThemeRuntime> => {
      if (!runtime) {
        runtime = import("./ThemeRuntime").then(({ createThemeRuntime }) => {
          loaded = createThemeRuntime({
            appearanceSettings,
            wanted,
            themes,
            active,
            activeId,
            previewing,
            paint,
          });
          if (unmounted) loaded.dispose();
          return loaded;
        });
        // A failed chunk load (e.g. after an update) may be retried.
        runtime.catch((e) => {
          runtime = null;
          logError(`Failed to load the theme runtime: ${e}`);
        });
      }
      return runtime;
    };

    /*
     * JET needs nothing but the class until the runtime is there; any other
     * theme waits for it (boot.js painted the cached colours meanwhile).
     */
    const sync = () => {
      if (loaded) return void loaded.sync();
      const { lightTheme, darkTheme } = appearanceSettings();
      if ((wanted.value === "light" ? lightTheme : darkTheme) !== JET) {
        return void load().then((rt) => rt.sync());
      }
      paint(wanted.value, null, null);
      activeId.value = JET;
      if (lightTheme === JET && darkTheme === JET) {
        store(
          THEME_CACHE_KEY,
          JSON.stringify({ v: 1, light: { id: JET, dark: false }, dark: { id: JET, dark: true } })
        );
      }
    };
    watch([() => ({ ...appearanceSettings() }), wanted], sync);
    sync();

    onMounted(() => whenIdle(() => void load().then((rt) => rt.sync()), 2000));
    onUnmounted(() => {
      unmounted = true;
      loaded?.dispose();
    });

    /* Runtime methods, loading the runtime on first use. */
    const lazy =
      <K extends Exclude<keyof ThemeRuntime, "sync" | "dispose">>(key: K) =>
      (...args: Parameters<ThemeRuntime[K]>) =>
        load().then((rt) => (rt[key] as (...a: unknown[]) => unknown)(...args));

    provide(ThemeContextKey, {
      themes,
      active,
      activeId,
      appearance: painted,
      previewing,
      resolved: lazy("resolved"),
      resolve: lazy("resolve"),
      preview: lazy("preview"),
      setTheme(id, mode) {
        const saved = appearanceSettings();
        if (mode !== "dark") saved.lightTheme = id;
        if (mode !== "light") saved.darkTheme = id;
        // Ends a preview (and repaints when nothing changed).
        if (loaded) void loaded.preview(null);
      },
      setColorScheme(scheme: ColorScheme) {
        appearanceSettings().colorScheme = scheme;
      },
      install: lazy("install"),
      save: lazy("save"),
      remove: lazy("remove"),
      loadFile: lazy("loadFile"),
      folder: lazy("folder"),
      openFolder: () => invoke<string>("open_themes_folder").then(() => undefined),
      reload: lazy("reload"),
    } as ThemeContext);

    return () => slots.default?.();
  },
};
