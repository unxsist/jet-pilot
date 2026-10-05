import { invoke } from "@tauri-apps/api/core";

let reset: Promise<void> | null = null;

/**
 * Once per page load: stops the backend log streams (`kubectl logs`) and
 * ends the log sessions a previous load of the webview left behind (their
 * channels are gone). Called at boot; log viewers await it before they
 * start a session, so a reset never ends a session of this page.
 */
export function resetLogStreams(): Promise<void> {
  if (!reset) {
    reset = invoke("log_stream_reset").then(
      () => undefined,
      () => undefined
    );
  }
  return reset;
}
