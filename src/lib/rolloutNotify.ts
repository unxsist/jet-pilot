/*
 * Follows rollouts started from JET Pilot ("Notify me") and tells once when
 * each has rolled out or is stuck: a desktop notification while JET Pilot
 * is in the background, a toast while it's in front. The notification
 * brings the app forward when clicked (the system does that), and the
 * workload then opens in the side panel. Followed rollouts live in memory
 * only, so quitting stops them.
 */
import { h, markRaw, type FunctionalComponent } from "vue";
import { ToastAction } from "radix-vue";
import { toast } from "@/components/ui/toast";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { openInPanel, tagged } from "@/lib/resources/open";
import type { SidePanel } from "@/providers/PanelProvider";
import { error as logError } from "@/lib/logger";
import {
  checkRollout,
  followName,
  rolloutMessage,
  type ProgressMark,
  type RolloutCheck,
  type RolloutMessage,
  type RolloutRef,
} from "./rolloutFollow";

/** A handful at once: each is a request every few seconds. */
export const MAX_FOLLOWED = 5;
const POLL_MS = 3000;
/* Long rollouts are fine; one that never ends stops being followed. */
const MAX_FOLLOW_MS = 2 * 60 * 60_000;
/* A notification opens its workload when JET Pilot comes forward within this. */
const OPEN_ON_FOCUS_MS = 10 * 60_000;

type SetSidePanel = ((panel: SidePanel | null) => void) | null;

interface Followed {
  name: string;
  refs: RolloutRef[];
  marks: (ProgressMark | null)[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  setSidePanel: SetSidePanel;
}

const followed = new Map<string, Followed>();
let notificationsAllowed: boolean | null = null;
let listening = false;
let pendingOpen: { ref: RolloutRef; setSidePanel: SetSidePanel; at: number } | null = null;

const refKey = (ref: RolloutRef) =>
  [ref.kubeConfig ?? "", ref.context, ref.namespace, ref.kind, ref.name].join("\u0000");

const pathOf = (ref: RolloutRef) =>
  apiPath({
    apiVersion: "apps/v1",
    resource: `${ref.kind.toLowerCase()}s`,
    namespace: ref.namespace,
    name: ref.name,
  });

const targetOf = (ref: RolloutRef) => ({ context: ref.context, kubeConfig: ref.kubeConfig || undefined });

const TOAST_ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center self-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/* --------------------------------------------------------- opening -- */

async function openWorkload(ref: RolloutRef, setSidePanel: SetSidePanel) {
  if (!setSidePanel) return;
  try {
    const object = await kubeGet(targetOf(ref), pathOf(ref));
    openInPanel(setSidePanel, null, tagged(object, { context: ref.context, kubeConfig: ref.kubeConfig ?? "" }));
  } catch (e) {
    toast({
      title: `Couldn't open ${ref.name}`,
      description: (e as { message?: string })?.message ?? String(e),
      variant: "destructive",
    });
  }
}

const OpenAction = (ref: RolloutRef, setSidePanel: SetSidePanel): FunctionalComponent => () =>
  h(
    ToastAction,
    { altText: `Open ${ref.name}`, class: TOAST_ACTION_CLASS, onClick: () => void openWorkload(ref, setSidePanel) },
    () => "Open"
  );

/* The app came forward (a notification was clicked, or the user switched back). */
const onFocus = () => {
  const pending = pendingOpen;
  pendingOpen = null;
  if (pending && Date.now() - pending.at < OPEN_ON_FOCUS_MS) {
    void openWorkload(pending.ref, pending.setSidePanel);
  }
};

/* ---------------------------------------------------- notifications -- */

/* Asked once, from the click on "Notify me" (macOS shows its prompt then). */
async function ensureNotifications(): Promise<boolean> {
  if (notificationsAllowed !== null) return notificationsAllowed;
  try {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    notificationsAllowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch (e) {
    logError(`Notifications unavailable: ${e}`);
    notificationsAllowed = false;
  }
  return notificationsAllowed;
}

async function announce(message: RolloutMessage, item: Followed) {
  const inFront = document.visibilityState === "visible" && document.hasFocus();
  if (!inFront && notificationsAllowed) {
    try {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title: message.title, body: message.body });
      pendingOpen = { ref: message.ref, setSidePanel: item.setSidePanel, at: Date.now() };
      return;
    } catch (e) {
      logError(`Couldn't send the rollout notification: ${e}`);
    }
  }
  toast({
    title: message.title,
    description: message.body,
    variant: message.outcome === "complete" ? "success" : message.outcome === "stuck" ? "destructive" : "warning",
    action: markRaw(OpenAction(message.ref, item.setSidePanel)),
    duration: message.outcome === "complete" ? 8000 : 20000,
  });
}

/* ---------------------------------------------------------- polling -- */

const stop = (key: string) => {
  const item = followed.get(key);
  if (item) clearTimeout(item.timer);
  followed.delete(key);
};

async function poll(key: string) {
  const item = followed.get(key);
  if (!item) return;
  const now = Date.now();
  let results: { ref: RolloutRef; check: RolloutCheck }[];
  try {
    results = await Promise.all(
      item.refs.map(async (ref, index) => {
        const workload = await kubeGet(targetOf(ref), pathOf(ref));
        const check = checkRollout({ ...workload, kind: ref.kind }, item.marks[index], now);
        if (check.state === "progressing") item.marks[index] = check.mark;
        return { ref, check };
      })
    );
  } catch (e) {
    // Deleted meanwhile: nothing to tell about. Anything else: try again.
    if ((e as { code?: number })?.code === 404) return stop(key);
    results = [];
  }
  if (!followed.has(key)) return;

  const message = rolloutMessage(item.name, results);
  if (message) {
    stop(key);
    await announce(message, item);
    return;
  }
  if (now - item.startedAt > MAX_FOLLOW_MS) return stop(key);
  item.timer = setTimeout(() => void poll(key), POLL_MS);
}

/** Starts following `refs` (one workload, or a release's) until they're done. */
export async function followRollout(
  refs: RolloutRef[],
  options: { name?: string; setSidePanel?: SetSidePanel } = {}
) {
  const key = refs.map(refKey).sort().join("\u0001");
  const name = options.name ?? followName(refs);
  if (followed.has(key)) {
    toast({ title: `Already following ${name}`, autoDismiss: true });
    return;
  }
  if (followed.size >= MAX_FOLLOWED) {
    toast({
      title: `Following ${MAX_FOLLOWED} rollouts already`,
      description: "Ask again once one of them has finished.",
      variant: "warning",
    });
    return;
  }

  followed.set(key, {
    name,
    refs,
    marks: refs.map(() => null),
    startedAt: Date.now(),
    timer: undefined,
    setSidePanel: options.setSidePanel ?? null,
  });
  if (!listening) {
    window.addEventListener("focus", onFocus);
    listening = true;
  }

  const allowed = await ensureNotifications();
  toast({
    title: `Following ${name}`,
    description: allowed
      ? "You'll hear when it has rolled out, or if it gets stuck."
      : "Notifications are off for JET Pilot, so the news shows up here.",
    autoDismiss: true,
  });
  void poll(key);
}
