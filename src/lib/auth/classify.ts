/*
 * Recognises authentication failures in error messages (API errors, watch
 * statuses, kubectl / helm stderr, exec plugin output). Errors that carry
 * the backend's `auth` info don't need this; everything else does.
 */
import type { AuthErrorInfo, AuthIssueKind } from "./types";

export interface AuthErrorClass {
  kind: AuthIssueKind;
  /** An expired AWS SSO session (`aws sso login`). */
  awsSso: boolean;
  /** An exec credential plugin (kubelogin, oidc-login, aws, ...) failed. */
  execPlugin: boolean;
}

const AWS_SSO =
  /error loading sso token|profile has expired|error when retrieving token from sso|token has expired and refresh failed/;
const EXEC_PLUGIN =
  /exec credential plugin|exec plugin|auth exec|getting credentials: exec|executable \S+ failed|kubelogin|oidc/;
const EXEC_MISSING = /executable file not found|fork\/exec \S+: no such file/;
const INTERACTION =
  /devicelogin|enter the code|device code|use a web browser|interactive login|browser to complete/;
const TIMEOUT = /timed out|timeout|deadline exceeded/;
const EXPIRED =
  /token (?:has )?expired|expired token|credentials? (?:have |has )?expired|session (?:has )?expired|refresh token|invalid_grant|re-?authenticate|(?:log|sign) ?in again/;
const UNAUTHORIZED = /\bunauthorized\b|must be logged in|provide credentials|\b401\b/;

/**
 * The kind of authentication failure `message` describes, or null when it
 * isn't one (network errors, RBAC "forbidden", TLS problems, ...).
 */
export function classifyAuthError(message: string): AuthErrorClass | null {
  const text = message.toLowerCase();
  // Server certificates: no sign-in fixes those.
  if (text.includes("x509")) return null;

  const awsSso =
    (text.includes("aws_profile") || text.includes("executable aws failed")) &&
    AWS_SSO.test(text);
  const execPlugin = awsSso || EXEC_PLUGIN.test(text);
  const of = (kind: AuthIssueKind): AuthErrorClass => ({ kind, awsSso, execPlugin });

  if (EXEC_MISSING.test(text)) return of("execMissing");
  if (INTERACTION.test(text)) return of("interactionRequired");
  if (execPlugin && TIMEOUT.test(text)) return of("timeout");
  if (awsSso || EXPIRED.test(text)) return of("expired");
  if (UNAUTHORIZED.test(text)) return of("unauthorized");
  if (execPlugin) return of("execFailed");
  return null;
}

/** Kinds a sign-in can fix (a missing tool or a timeout it can't). */
export const isSignInIssue = (kind: AuthIssueKind): boolean =>
  kind !== "execMissing" && kind !== "timeout";

/** The message of an error value (Error, API error object or string). */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** The backend's `auth` info of an API error, if it has one. */
export function authInfoOf(error: unknown): AuthErrorInfo | null {
  const auth =
    error && typeof error === "object"
      ? (error as { auth?: AuthErrorInfo | null }).auth
      : null;
  return auth && typeof auth.kind === "string" ? auth : null;
}

/* SerializableKubeError reasons of authentication failures. */
const REASON_KINDS = new Map<unknown, AuthIssueKind>([
  ["InteractionRequired", "interactionRequired"],
  ["CredentialExpired", "expired"],
  ["Unauthorized", "unauthorized"],
  ["ExecAuthFailed", "execFailed"],
  ["ToolMissing", "execMissing"],
  ["ExecTimeout", "timeout"],
]);

/** The issue kind of an API error's `reason`, if it is an auth failure. */
export function reasonKindOf(error: unknown): AuthIssueKind | null {
  const reason =
    error && typeof error === "object" ? (error as { reason?: unknown }).reason : null;
  return REASON_KINDS.get(reason) ?? null;
}
