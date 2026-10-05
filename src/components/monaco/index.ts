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
 */
export function useMonacoTheme() {
  const theme = useTheme();
  let painting: MonacoRuntime | null = null;
  watch(theme.active, (active) => {
    if (active && painting) painting.applyMonacoTheme(active.monaco);
  });
  return async (rt: MonacoRuntime) => {
    painting = rt;
    rt.applyMonacoTheme((await theme.resolved()).monaco);
  };
}
