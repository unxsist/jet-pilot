/*
 * Entry point for Monaco consumers. Importing this module is cheap: the
 * editor runtime (./monaco.ts, a few MB with workers) is only downloaded and
 * evaluated on the first `loadMonaco()` call, i.e. when an editor surface
 * actually opens.
 */
import { watch } from "vue";
import { useTheme } from "@/providers/ThemeProvider";

export type MonacoRuntime = typeof import("./monaco");

let runtime: Promise<MonacoRuntime> | null = null;

export function loadMonaco(): Promise<MonacoRuntime> {
  if (!runtime) {
    runtime = import("./monaco");
    // A failed chunk load (e.g. after an app update) may be retried.
    runtime.catch(() => (runtime = null));
  }
  return runtime;
}

/** Shared editor options (typography, chrome) for every Monaco surface. */
export { editorOptions } from "./editorOptions";

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Keeps Monaco (whose themes are global) painted with the active app theme.
 * Call in setup; await the returned function with the runtime before
 * creating editors, so they never show a default theme first.
 *
 * While the theme runtime is still loading, an app painted with JET (no
 * `data-theme-id` on <html>) gets JET's editor colours right away instead
 * of waiting for the runtime and the themes folder; the resolved theme
 * follows once it is there. If the runtime fails, editors fall back to JET.
 */
export function useMonacoTheme() {
  const theme = useTheme();
  let painting: MonacoRuntime | null = null;
  watch(theme.active, (active) => {
    if (active && painting) painting.applyMonacoTheme(active.monaco);
  });
  const paintJet = async (rt: MonacoRuntime) => {
    const { JetDark, JetLight } = await import("./themes/jet");
    // The runtime may have resolved meanwhile.
    if (!theme.active.value) {
      rt.applyMonacoTheme(theme.appearance.value === "dark" ? JetDark : JetLight);
    }
  };
  return async (rt: MonacoRuntime) => {
    painting = rt;
    if (theme.active.value) return rt.applyMonacoTheme(theme.active.value.monaco);
    if (!document.documentElement.dataset.themeId) {
      // Loads the runtime if needed; the watch above applies the result.
      void theme.resolved().catch(() => undefined);
      return paintJet(rt);
    }
    try {
      rt.applyMonacoTheme((await theme.resolved()).monaco);
    } catch {
      await paintJet(rt);
    }
  };
}
