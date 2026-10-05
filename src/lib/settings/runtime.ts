/*
 * Read access to the live settings for code outside components (list
 * controllers, kubectl helpers). SettingsContextProvider registers the
 * store once it is loaded; before that (and in unit tests) the getters fall
 * back to the defaults.
 */
import type { Settings } from "./types";

let current: (() => Settings) | null = null;

export function setRuntimeSettings(getter: (() => Settings) | null): void {
  current = getter;
}

/** The settings, or null before they are loaded. */
export function runtimeSettings(): Settings | null {
  return current?.() ?? null;
}

/** `--request-timeout` for kubectl calls (Settings › Advanced › Network). */
export function kubectlRequestTimeoutArg(): string {
  return `--request-timeout=${runtimeSettings()?.network?.requestTimeout ?? 30}s`;
}

/** Polling interval of lists that are polled (ms). */
export function pollInterval(): number {
  return runtimeSettings()?.tables?.pollInterval ?? 5000;
}
