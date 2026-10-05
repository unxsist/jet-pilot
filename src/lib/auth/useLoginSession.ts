/*
 * Drives one login session: starts it with a channel, reduces its events
 * into the view state (loginSession.ts), cancels it when the component goes
 * away. Used by the sign-in dialog; any device-code flow that streams
 * `LoginEvent`s (e.g. AWS SSO) can use it with LoginSessionPanel.
 */
import { onScopeDispose, shallowRef } from "vue";
import { Channel } from "@tauri-apps/api/core";
import { errorText } from "./classify";
import {
  initialLoginState,
  isFinished,
  reduceLogin,
  type LoginViewState,
} from "./loginSession";
import type { LoginEvent } from "./types";

export interface LoginRunner {
  /** Starts the login; resolves with its session id. */
  start: (channel: Channel<LoginEvent>) => Promise<string>;
  cancel?: (sessionId: string) => Promise<unknown>;
  /** Opens a URL the login printed (only those). */
  openUrl?: (sessionId: string, url: string) => Promise<unknown>;
}

export function useLoginSession(
  runner: LoginRunner,
  onFinished?: (state: LoginViewState) => void
) {
  const state = shallowRef<LoginViewState>(initialLoginState());
  let session: Promise<string | null> = Promise.resolve(null);
  let generation = 0;
  /** A session is running in the backend (not finished, not stopped). */
  let running = false;

  const apply = (event: LoginEvent) => {
    const before = state.value;
    const next = reduceLogin(before, event);
    if (next === before) return;
    state.value = next;
    if (isFinished(next)) {
      running = false;
      onFinished?.(next);
    }
  };

  /** Starts (or restarts) the login. */
  const begin = () => {
    void stop();
    const current = ++generation;
    running = true;
    state.value = initialLoginState();
    const channel = new Channel<LoginEvent>();
    // Events can arrive before the session id: gate on the generation.
    channel.onmessage = (event) => {
      if (current === generation) apply(event);
    };
    session = runner.start(channel).then(
      (id) => {
        if (current !== generation) {
          void runner.cancel?.(id).catch(() => undefined);
          return null;
        }
        return id;
      },
      (e) => {
        if (current === generation) apply({ type: "failed", message: errorText(e) });
        return null;
      }
    );
  };

  /* Ends the running session (if any) without changing the view. */
  const stop = async () => {
    const wasRunning = running;
    running = false;
    generation++;
    const id = await session;
    if (id && wasRunning) await runner.cancel?.(id).catch(() => undefined);
  };

  const cancel = () => {
    if (!isFinished(state.value)) state.value = { ...state.value, phase: "cancelled" };
    return stop();
  };

  const openUrl = async (url: string) => {
    const id = await session;
    if (id && runner.openUrl) await runner.openUrl(id, url);
  };

  onScopeDispose(() => void stop());

  return { state, begin, cancel, openUrl };
}
