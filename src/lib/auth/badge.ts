/*
 * What a compact credential badge says (CredentialBadge.vue): pure, so the
 * rules are unit-tested.
 */
import type { CredentialView } from "./center";

export type BadgeTone = "success" | "warning" | "destructive" | "info" | "muted";

export interface CredentialBadgeModel {
  text: string;
  tone: BadgeTone;
  /** Clicking signs in. */
  signIn: boolean;
  title: string;
}

/** Below this, an expiry is a warning. */
export const EXPIRY_WARNING_MS = 15 * 60_000;

/** "<1m", "12m", "3h", "2d". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function credentialBadge(view: CredentialView, now: number): CredentialBadgeModel | null {
  const canSignIn = view.canSignIn;
  if (view.signingIn) {
    return { text: "Signing in…", tone: "info", signIn: false, title: "Signing in" };
  }
  const remaining = view.expiresAt !== null ? view.expiresAt - now : null;
  if (view.state === "expired" || (remaining !== null && remaining <= 0)) {
    return {
      text: "Expired",
      tone: "destructive",
      signIn: canSignIn,
      title: canSignIn ? "Credentials expired: sign in" : "Credentials expired",
    };
  }
  if (view.state === "needsLogin") {
    return {
      text: "Sign-in needed",
      tone: "warning",
      signIn: canSignIn,
      title: view.lastIssue?.message || "Sign in to connect",
    };
  }
  if (remaining !== null) {
    const soon = remaining < EXPIRY_WARNING_MS || view.state === "expiringSoon";
    return {
      text: `Expires in ${formatRemaining(remaining)}`,
      tone: soon ? "warning" : "muted",
      signIn: soon && canSignIn,
      title: new Date(view.expiresAt!).toLocaleString(),
    };
  }
  if (view.state === "expiringSoon") {
    return { text: "Expires soon", tone: "warning", signIn: canSignIn, title: "Sign in again" };
  }
  if (view.state === "valid" && view.status?.kind !== "none") {
    return { text: "Signed in", tone: "success", signIn: false, title: "Credentials are valid" };
  }
  return null;
}
