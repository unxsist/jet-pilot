/*
 * A sign-in in progress, as the sign-in dialog shows it: a pure reducer over
 * the `LoginEvent`s of `auth_login_start` (and of other device-code flows).
 */
import type { LoginEvent } from "./types";

export type LoginPhase = "starting" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface LoginLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
}

export interface LoginViewState {
  phase: LoginPhase;
  /** The command signing in (e.g. "kubelogin get-token …"). */
  command: string | null;
  deviceCode: DeviceCode | null;
  /** A sign-in page the login printed (browser flows). */
  url: string | null;
  /** Host of the page "Open browser" opens: shown prominently (anti-phishing). */
  domain: string | null;
  /** Output, redacted; only the last MAX_LOGIN_LINES are kept. */
  lines: LoginLine[];
  droppedLines: number;
  expiresAt: number | null;
  error: string | null;
}

export const MAX_LOGIN_LINES = 200;

export const initialLoginState = (): LoginViewState => ({
  phase: "starting",
  command: null,
  deviceCode: null,
  url: null,
  domain: null,
  lines: [],
  droppedLines: 0,
  expiresAt: null,
  error: null,
});

export const isFinished = (state: LoginViewState): boolean =>
  state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";

/** Lower-case host of an http(s) URL, else null. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** The page "Open browser" opens. */
export function browserUrl(state: LoginViewState): string | null {
  const code = state.deviceCode;
  return code ? code.verificationUriComplete || code.verificationUri : state.url;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const BEARER = /(bearer\s+)\S+/gi;
const SECRET_FIELD =
  /((?:access|refresh|id)?_?token|secret|password|client_secret)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi;
const OPAQUE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
/* File paths are long too: keep `/usr/local/bin/…`. */
const isPath = (text: string) =>
  text.startsWith("/") && !/[+=]/.test(text) && text.split("/").length > 2;

/**
 * Output lines are redacted by the backend already; this masks anything
 * token-like that slipped through (JWTs, bearer tokens, `token=…` fields,
 * long opaque strings) and strips terminal colours.
 */
export function redactLine(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(JWT, "[redacted]")
    .replace(BEARER, "$1[redacted]")
    .replace(SECRET_FIELD, "$1$2[redacted]")
    .replace(OPAQUE, (match) => (isPath(match) ? match : "[redacted]"));
}

export function reduceLogin(state: LoginViewState, event: LoginEvent): LoginViewState {
  // Late events of a finished (or cancelled) login.
  if (isFinished(state)) return state;

  switch (event.type) {
    case "started":
      return { ...state, phase: "waiting", command: event.command };
    case "line": {
      const lines = [...state.lines, { stream: event.stream, text: redactLine(event.text) }];
      const dropped = Math.max(0, lines.length - MAX_LOGIN_LINES);
      return {
        ...state,
        lines: dropped ? lines.slice(dropped) : lines,
        droppedLines: state.droppedLines + dropped,
      };
    }
    case "deviceCode": {
      const deviceCode: DeviceCode = {
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        verificationUriComplete: event.verificationUriComplete ?? null,
      };
      const next = { ...state, phase: "waiting" as const, deviceCode };
      return { ...next, domain: hostOf(browserUrl(next) ?? "") };
    }
    case "url": {
      const next = { ...state, phase: "waiting" as const, url: event.url };
      return { ...next, domain: hostOf(browserUrl(next) ?? "") };
    }
    case "succeeded":
      return { ...state, phase: "succeeded", expiresAt: event.expiresAt ?? null };
    case "failed":
      return { ...state, phase: "failed", error: redactLine(event.message) };
    case "cancelled":
      return { ...state, phase: "cancelled" };
    default:
      // Newer events (prompts, progress) this version doesn't show.
      return state;
  }
}
