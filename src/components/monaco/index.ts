/*
 * Entry point for Monaco consumers. Importing this module is cheap: the
 * editor runtime (./monaco.ts, a few MB with workers) is only downloaded and
 * evaluated on the first `loadMonaco()` call, i.e. when an editor surface
 * actually opens.
 */
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
export { editorOptions } from "./themes/jet";

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
