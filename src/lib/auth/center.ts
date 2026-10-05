/*
 * The auth center: one place that knows which clusters need the user to sign
 * in, for components and non-component code (list controllers, providers).
 *
 * - `report()` records an authentication failure (from an API error, a watch
 *   status, kubectl output or an `auth://issue` event). It never opens a
 *   dialog or starts a login: it marks the cluster and shows one toast per
 *   credential (contexts sharing a kubeconfig + exec command, or an AWS
 *   profile) per session.
 * - `requestSignIn()` opens the sign-in dialog (AuthHost): user actions only.
 * - A sign-in (or `auth://resolved`) fans out to every affected cluster:
 *   `onRecovered()` callbacks retry watches, streams and port forwards.
 * - Credential status (`auth_credential_status`) is refreshed every minute
 *   while the window is visible, and when a credential expires.
 *
 * Only this core is part of the startup bundle. AuthHost (App.vue, loaded
 * after the first paint) renders the dialog and the toasts (notify.ts):
 * issues reported before it is there are replayed to it.
 */
import {
  computed,
  reactive,
  shallowRef,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { contextKey } from "@/lib/contextKey";
import {
  authInfoOf,
  classifyAuthError,
  errorText,
  isSignInIssue,
  reasonKindOf,
} from "./classify";
import type {
  AuthIssue,
  AuthResolved,
  AuthSource,
  AuthTarget,
  CredentialState,
  CredentialStatus,
} from "./types";

export type * from "./types";

export interface CredentialView {
  key: string;
  target: AuthTarget;
  status: CredentialStatus | null;
  state: CredentialState;
  /** Signing in would fix it (expired, or the cluster rejected it). */
  needsSignIn: boolean;
  canSignIn: boolean;
  signInLabel: string | null;
  /** Unix ms. */
  expiresAt: number | null;
  signingIn: boolean;
  lastIssue: AuthIssue | null;
}

interface Entry {
  status: CredentialStatus | null;
  issue: AuthIssue | null;
  signingIn: boolean;
  /** Last recovery (ms): stale failures right after it are ignored. */
  recoveredAt: number;
}

const REFRESH_MS = 60_000;
const RECOVERY_GRACE_MS = 5_000;

const entries = reactive(new Map<string, Entry>());
/** Every context asked about: what `refresh()` checks. */
const known = new Map<string, AuthTarget>();
/** Contexts whose status was fetched (or queued) once. */
const fetched = new Set<string>();

export const keyOf = (target: AuthTarget) => contextKey(target.context, target.kubeConfig);
const targetOf = (target: AuthTarget): AuthTarget => ({
  context: target.context,
  kubeConfig: target.kubeConfig ?? "",
});

function entryFor(target: AuthTarget): Entry {
  const key = keyOf(target);
  let entry = entries.get(key);
  if (!entry) {
    entries.set(key, { status: null, issue: null, signingIn: false, recoveredAt: 0 });
    entry = entries.get(key)!;
  }
  known.set(key, targetOf(target));
  return entry;
}

/* ------------------------------------------------------------ views -- */

/** The credential of `target` (reactive when read in a computed / render). */
export function credentialView(target: AuthTarget): CredentialView {
  const key = keyOf(target);
  if (target.context) watchTarget(key, target);
  const entry = entries.get(key);
  const status = entry?.status ?? null;
  const issue = entry?.issue ?? null;

  let state: CredentialState = status?.state ?? "unknown";
  if (issue && isSignInIssue(issue.kind)) {
    state = issue.kind === "expired" || state === "expired" ? "expired" : "needsLogin";
  }
  return {
    key,
    target,
    status,
    state,
    needsSignIn: state === "expired" || state === "needsLogin",
    canSignIn: status?.canSignIn ?? true,
    signInLabel: status?.signInLabel ?? null,
    expiresAt: status?.expiresAt ?? null,
    signingIn: entry?.signingIn ?? false,
    lastIssue: issue,
  };
}

/** The credential of a (changing) target, e.g. the primary context. */
export function credential(target: MaybeRefOrGetter<AuthTarget>): ComputedRef<CredentialView> {
  return computed(() => credentialView(targetOf(toValue(target))));
}

/** `credential()` for components that know a context by name + kubeconfig. */
export function useCredential(
  context: MaybeRefOrGetter<string>,
  kubeConfig: MaybeRefOrGetter<string | undefined>
): ComputedRef<CredentialView> {
  return credential(() => ({ context: toValue(context), kubeConfig: toValue(kubeConfig) ?? "" }));
}

/* ---------------------------------------------------------- reports -- */

function toIssue(target: AuthTarget, error: unknown, source: AuthSource): AuthIssue | null {
  const value = error as Partial<AuthIssue> | null;
  const message = errorText(error);
  // An AuthIssue (`auth://issue`).
  if (typeof value?.source === "string" && typeof value.kind === "string") {
    return { ...targetOf(target), kind: value.kind, source, message, command: value.command ?? null };
  }
  const info = authInfoOf(error);
  if (info) return { ...targetOf(target), kind: info.kind, source, message, command: info.command ?? null };
  const kind = reasonKindOf(error) ?? classifyAuthError(message)?.kind;
  return kind ? { ...targetOf(target), kind, source, message, command: null } : null;
}

/**
 * Records an authentication failure of `target` (an error, a message or an
 * AuthIssue). Returns true when it is one a sign-in fixes: the caller can
 * keep it out of its error banner (the notice and toast cover it) and retry
 * on `onRecovered`. Never opens a dialog or starts a login. Only active
 * clusters get a toast: the others (e.g. the Clusters hub's background
 * checks) just show their state.
 */
export function report(target: AuthTarget, error: unknown, source: AuthSource): boolean {
  if (!target.context) return false;
  const issue = toIssue(target, error, source);
  if (!issue) return false;
  start();
  const entry = entryFor(target);
  const signIn = isSignInIssue(issue.kind) && (entry.status?.canSignIn ?? true);
  // A failure still in flight while the sign-in completed.
  if (Date.now() - entry.recoveredAt < RECOVERY_GRACE_MS) return signIn;

  watchTarget(keyOf(target), target);
  entry.issue = issue;
  if (signIn && !entry.signingIn && activeKeys.has(keyOf(target))) {
    if (issueListeners.size === 0) unheard = [...unheard.slice(-49), issue];
    for (const listener of issueListeners) listener(issue);
  }
  return signIn;
}

/* The active clusters (KubeContextProvider keeps this up to date). */
let activeKeys = new Set<string>();

/** KubeContextProvider: the clusters in use; only their issues are toasted. */
export function setActiveClusters(targets: AuthTarget[]): void {
  activeKeys = new Set(targets.map(keyOf));
}

const issueListeners = new Set<(issue: AuthIssue) => void>();
let unheard: AuthIssue[] = [];

/**
 * Internal (notify.ts): called with every new issue a sign-in fixes. The
 * first listener also gets the ones reported before it existed.
 */
export function onIssue(listener: (issue: AuthIssue) => void): () => void {
  issueListeners.add(listener);
  const replay = unheard;
  unheard = [];
  for (const issue of replay) listener(issue);
  return () => issueListeners.delete(listener);
}

/**
 * Data loaded fine for `target`: a credential that was reported failing
 * works again (e.g. after signing in outside JET Pilot), so recover.
 */
export function reportHealthy(target: AuthTarget): void {
  if (entries.get(keyOf(target))?.issue) recover([target]);
}

/* --------------------------------------------------------- recovery -- */

type RecoveredCallback = (target: AuthTarget) => void;
const recoveredCallbacks = new Map<string, Set<RecoveredCallback>>();
const recoveredHooks = new Set<(targets: AuthTarget[]) => void>();

/**
 * Calls `callback` whenever `target` (or with "*", any context) recovers:
 * a sign-in succeeded or the backend resolved its issue. Returns the
 * unsubscribe function.
 */
export function onRecovered(target: AuthTarget | "*", callback: RecoveredCallback): () => void {
  start();
  const key = target === "*" ? "*" : keyOf(target);
  let set = recoveredCallbacks.get(key);
  if (!set) recoveredCallbacks.set(key, (set = new Set()));
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0 && recoveredCallbacks.get(key) === set) recoveredCallbacks.delete(key);
  };
}

/** Internal: notified with every fan-out (toasts, the sign-in dialog). */
export function onRecoveredBatch(hook: (targets: AuthTarget[]) => void): () => void {
  recoveredHooks.add(hook);
  return () => recoveredHooks.delete(hook);
}

/** Fans a resolved credential out to every affected context. */
export function recover(targets: AuthTarget[]): void {
  const now = Date.now();
  const list = targets.map(targetOf);
  for (const target of list) {
    const entry = entryFor(target);
    entry.issue = null;
    entry.signingIn = false;
    entry.recoveredAt = now;
    if (entry.status && (entry.status.state === "expired" || entry.status.state === "needsLogin")) {
      // Until the refresh below says otherwise.
      entry.status = { ...entry.status, state: "valid", expiresAt: null };
    }
  }
  for (const hook of recoveredHooks) safely(() => hook(list));
  for (const target of list) {
    const callbacks = [
      ...(recoveredCallbacks.get(keyOf(target)) ?? []),
      ...(recoveredCallbacks.get("*") ?? []),
    ];
    for (const callback of callbacks) safely(() => callback(target));
  }
  if (list.length > 0) void refresh(list);
}

function safely(fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error("[auth] recovery callback failed", e);
  }
}

/* ---------------------------------------------------------- sign in -- */

export interface SignInRequest {
  id: number;
  target: AuthTarget;
}

/** The open sign-in dialog (AuthHost renders it). */
export const signInRequest = shallowRef<SignInRequest | null>(null);
let settleSignIn: ((signedIn: boolean) => void) | null = null;
let pendingSignIn: Promise<boolean> | null = null;
let requestIds = 0;
let hosts = 0;

/**
 * Opens the sign-in dialog for `target` (user actions only). Resolves when
 * it closes: true when the sign-in succeeded.
 */
export function requestSignIn(target: AuthTarget): Promise<boolean> {
  start();
  const open = signInRequest.value;
  if (open && pendingSignIn && keyOf(open.target) === keyOf(target)) return pendingSignIn;
  closeSignIn(false);
  pendingSignIn = new Promise<boolean>((resolve) => {
    settleSignIn = resolve;
    signInRequest.value = { id: ++requestIds, target: targetOf(target) };
  });
  if (hosts === 0) console.warn("[auth] no AuthHost mounted: the sign-in dialog can't open");
  return pendingSignIn;
}

/** Closes the sign-in dialog. */
export function closeSignIn(signedIn: boolean): void {
  const settle = settleSignIn;
  settleSignIn = null;
  pendingSignIn = null;
  signInRequest.value = null;
  settle?.(signedIn);
}

/** AuthHost calls this while mounted; returns the unregister function. */
export function registerAuthHost(): () => void {
  hosts++;
  return () => {
    hosts--;
  };
}

/** The sign-in dialog marks the credential while a login runs. */
export function setSigningIn(target: AuthTarget, signingIn: boolean): void {
  entryFor(target).signingIn = signingIn;
}

/* ----------------------------------------------------------- status -- */

let pendingFetch = new Map<string, AuthTarget>();
let fetchQueued = false;
let lastRefresh = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let statusUnavailable = false;

/* First sight of a context: fetch its status (batched per tick). */
function watchTarget(key: string, target: AuthTarget) {
  if (fetched.has(key)) return;
  fetched.add(key);
  known.set(key, targetOf(target));
  pendingFetch.set(key, targetOf(target));
  start();
  if (fetchQueued) return;
  fetchQueued = true;
  queueMicrotask(() => {
    fetchQueued = false;
    const batch = [...pendingFetch.values()];
    pendingFetch = new Map();
    void refresh(batch);
  });
}

/** Fetches the credential status of `targets` (default: every known context). */
export async function refresh(targets?: AuthTarget[]): Promise<void> {
  const contexts = (targets ?? [...known.values()]).filter((target) => target.context);
  if (contexts.length === 0) return;
  if (!targets) lastRefresh = Date.now();
  try {
    const statuses = await invoke<CredentialStatus[] | null>("auth_credential_status", { contexts });
    for (const status of statuses ?? []) entryFor(status).status = status;
    statusUnavailable = false;
  } catch (e) {
    if (!statusUnavailable) console.warn(`[auth] credential status unavailable: ${errorText(e)}`);
    statusUnavailable = true;
  }
  scheduleExpiryRefresh();
}

/* Refresh when the next credential expires (or is about to, < 15 min). */
function scheduleExpiryRefresh() {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const now = Date.now();
  let next = Infinity;
  for (const entry of entries.values()) {
    const at = entry.status?.expiresAt;
    if (!at) continue;
    for (const moment of [at - 15 * 60_000, at]) {
      if (moment > now && moment < next) next = moment;
    }
  }
  if (next - now < 24 * 3600_000) {
    expiryTimer = setTimeout(() => void refresh(), next - now + 1000);
  }
}

/* ------------------------------------------------------------ start -- */

let started = false;

function start() {
  if (started) return;
  started = true;
  listen<AuthIssue>("auth://issue", ({ payload }) => {
    report(payload, payload, payload.source);
  }).catch(() => undefined);
  listen<AuthResolved>("auth://resolved", ({ payload }) => {
    recover(payload.contexts ?? []);
  }).catch(() => undefined);

  if (typeof document === "undefined") return;
  const visibleRefresh = () => {
    if (!document.hidden && Date.now() - lastRefresh >= REFRESH_MS) void refresh();
  };
  setInterval(visibleRefresh, REFRESH_MS);
  document.addEventListener("visibilitychange", visibleRefresh);
}

/** Tests only: forget everything. */
export function resetAuthCenterForTests(): void {
  entries.clear();
  known.clear();
  fetched.clear();
  recoveredCallbacks.clear();
  recoveredHooks.clear();
  issueListeners.clear();
  unheard = [];
  activeKeys = new Set();
  pendingFetch.clear();
  closeSignIn(false);
  hosts = 0;
  started = false;
  statusUnavailable = false;
}
