/*
 * Sign-in toasts, shown while AuthHost is mounted: one per credential per
 * session. Contexts sharing a credential (an AWS profile, or a kubeconfig
 * + exec command) share a toast: "Sign-in needed for prod (and 2 more)". A
 * credential gets a new toast only after it recovered and failed again.
 */
import { h, watch, type FunctionalComponent } from "vue";
import { invoke } from "@tauri-apps/api/core";
/*
 * radix-vue's action with the app's ToastAction classes (like
 * lib/guardrails/guard.ts).
 */
import { ToastAction } from "radix-vue";
import { toast, useToast } from "@/components/ui/toast";
import { resolveCluster } from "@/lib/clusters/meta";
import { runtimeSettings } from "@/lib/settings/runtime";
import {
  credentialView,
  keyOf,
  onIssue,
  onRecoveredBatch,
  refresh,
  requestSignIn,
  signInRequest,
} from "./center";
import type { AuthIssue, AuthTarget, CredentialStatus } from "./types";

interface ToastGroup {
  members: Map<string, AuthTarget>;
  toast: ReturnType<typeof toast> | null;
}

const groups = new Map<string, ToastGroup>();
/** Context key -> its group key ("" while being placed). */
const memberOf = new Map<string, string>();

const TOAST_ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center self-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const basename = (command: string) => command.split(/[\\/]/).pop() || command;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (target: AuthTarget) =>
  resolveCluster(runtimeSettings()?.clusters, target.context, target.kubeConfig).displayName;

async function awsProfileOf(target: AuthTarget): Promise<string | null> {
  try {
    const info = await invoke<{ awsProfile: string | null }>("get_context_auth_info", {
      context: target.context,
      kubeConfig: target.kubeConfig || null,
    });
    return info?.awsProfile ?? null;
  } catch {
    return null;
  }
}

/** Which credential `issue` is about: contexts sharing it share a toast. */
async function groupKey(issue: AuthIssue, status: CredentialStatus | null): Promise<string> {
  const command = issue.command || status?.command || null;
  let profile = status?.awsProfile ?? null;
  if (!profile && command && basename(command) === "aws") profile = await awsProfileOf(issue);
  if (profile) return `aws\u0000${profile}`;
  if (command) return `exec\u0000${issue.kubeConfig}\u0000${basename(command)}`;
  return `context\u0000${keyOf(issue)}`;
}

const SignInAction = (target: AuthTarget): FunctionalComponent => () =>
  h(
    ToastAction,
    { altText: "Sign in", class: TOAST_ACTION_CLASS, onClick: () => void requestSignIn(target) },
    () => "Sign in"
  );

const isOpen = (id: string) =>
  useToast().toasts.value.some((t) => t.id === id && t.open !== false);

function show(group: ToastGroup, issue: AuthIssue) {
  const members = [...group.members.values()];
  const first = members[0]!;
  const more = members.length - 1;
  const title = `Sign-in needed for ${nameOf(first)}${more > 0 ? ` (and ${more} more)` : ""}`;
  if (group.toast) {
    // Dismissed: not again this session.
    if (isOpen(group.toast.id)) group.toast.update({ id: group.toast.id, title });
    return;
  }
  group.toast = toast({
    title,
    description:
      issue.kind === "expired"
        ? "Its credentials expired. Open views reconnect once you sign in."
        : "Open views reconnect once you sign in.",
    variant: "warning",
    duration: 10_000,
    action: SignInAction(first),
  });
}

async function notifyIssue(issue: AuthIssue): Promise<void> {
  const key = keyOf(issue);
  if (memberOf.has(key)) return;
  memberOf.set(key, "");

  if (!credentialView(issue).status) {
    await Promise.race([refresh([issue]), sleep(1500)]);
  }
  const view = credentialView(issue);
  if (!view.lastIssue || view.signingIn || !view.canSignIn || !view.needsSignIn) {
    memberOf.delete(key);
    return;
  }
  const group = await groupKey(issue, view.status);
  if (memberOf.get(key) !== "") return; // recovered meanwhile
  memberOf.set(key, group);
  let entry = groups.get(group);
  if (!entry) groups.set(group, (entry = { members: new Map(), toast: null }));
  entry.members.set(key, { context: issue.context, kubeConfig: issue.kubeConfig });
  show(entry, issue);
}

/* The sign-in dialog opened for `target`: its toast has done its job. */
function dismissIssueToast(target: AuthTarget): void {
  const group = groups.get(memberOf.get(keyOf(target)) ?? "");
  group?.toast?.dismiss();
}

/* Recovered credentials: drop them, so failing again toasts again. */
function dropRecovered(targets: AuthTarget[]): void {
  for (const target of targets) {
    const key = keyOf(target);
    const groupKey = memberOf.get(key);
    memberOf.delete(key);
    const group = groupKey ? groups.get(groupKey) : undefined;
    if (!group) continue;
    group.members.delete(key);
    if (group.members.size === 0) {
      group.toast?.dismiss();
      groups.delete(groupKey!);
    }
  }
}

/** AuthHost: shows the toasts while mounted. Returns the stop function. */
export function startIssueToasts(): () => void {
  const stops = [
    onIssue((issue) => void notifyIssue(issue)),
    onRecoveredBatch(dropRecovered),
    watch(signInRequest, (request) => request && dismissIssueToast(request.target)),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Tests only. */
export function resetNotifyForTests(): void {
  groups.clear();
  memberOf.clear();
}
