/*
 * guard(): the guardrails in front of everything that changes a cluster.
 * Resolves the cluster metadata of every target, then
 * - blocks read-only clusters (a toast that links to the cluster's
 *   settings),
 * - asks for the typed confirmation on protected clusters (in place of the
 *   caller's own confirmation),
 * - otherwise runs the caller's own confirmation, if it has one.
 * The typed confirmation is rendered by GuardrailsHost (App.vue).
 */
import { computed, createApp, h, type FunctionalComponent } from "vue";
import { hostCount, openTypedConfirm, settle, type TypedConfirmRequest } from "./host";
import { toast } from "@/components/ui/toast";
/*
 * radix-vue's action with the app's ToastAction classes: importing
 * ToastAction.vue here would pull it into the startup bundle.
 */
import { ToastAction } from "radix-vue";
import type {
  BaseDialogInterface,
  DialogButtonInterface,
} from "@/providers/DialogProvider";
import type { ResolvedCluster } from "@/lib/clusters/meta";
import { runtimeSettings } from "@/lib/settings/runtime";
import { guardedCluster } from "./backstop";
import {
  decideMany,
  effectOf,
  isBlocked,
  readOnlyReason,
  verbOf,
  type ActionKind,
} from "./policy";

export interface GuardTarget {
  context: string;
  kubeConfig?: string;
  name?: string;
  /** Kubernetes kind ("Pod"), or e.g. "release" / "node". */
  kind?: string;
  namespace?: string;
}

/** Targets of table rows (Kubernetes objects or Helm release rows). */
export function rowTargets(rows: readonly unknown[], kind?: string): GuardTarget[] {
  return rows.map((row) => {
    const r = row as {
      kind?: string;
      name?: string;
      namespace?: string;
      metadata?: { context?: string; kubeConfig?: string; name?: string; namespace?: string };
    };
    return {
      context: r.metadata?.context ?? "",
      kubeConfig: r.metadata?.kubeConfig,
      name: r.metadata?.name ?? r.name,
      kind: kind ?? r.kind,
      namespace: r.metadata?.namespace ?? r.namespace,
    };
  });
}

/* ------------------------------------------------------- read-only -- */

/** Opens the cluster in the Clusters hub's edit dialog. */
export async function editCluster(key: string): Promise<void> {
  const { default: router } = await import("@/router");
  try {
    await router.push({ name: "ClustersHub", query: { edit: key } });
  } catch {
    // The hub isn't there (yet): nothing to open.
  }
}

const TOAST_ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center self-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const EditClusterAction = (key: string): FunctionalComponent => () =>
  h(
    ToastAction,
    { altText: "Edit cluster", class: TOAST_ACTION_CLASS, onClick: () => editCluster(key) },
    () => "Edit cluster"
  );

export function readOnlyToast(cluster: ResolvedCluster): void {
  toast({
    title: readOnlyReason(cluster),
    description: "Changes from JET Pilot are turned off for this cluster.",
    variant: "warning",
    action: EditClusterAction(cluster.key),
  });
}

/**
 * Read-only check alone, for actions that open a form or tab whose submit
 * runs guard() (the typed confirmation belongs there). Toasts and returns
 * false when a read-only cluster blocks `kind`.
 */
export function allowed(kind: ActionKind, targets: GuardTarget[]): boolean {
  for (const target of targets) {
    const cluster = guardedCluster(target.context, target.kubeConfig);
    if (isBlocked(kind, cluster)) {
      readOnlyToast(cluster);
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------ typed confirmation -- */

export type { TypedConfirmRequest } from "./host";
export { pendingConfirm, registerHost, settle } from "./host";

/*
 * Without a GuardrailsHost in the app, a detached one is mounted (with the
 * settings, for the cluster labels) so a confirmation never hangs.
 */
async function ensureHost(): Promise<void> {
  if (hostCount() > 0) return;
  const [{ default: GuardrailsHost }, { SettingsContextStateKey }] = await Promise.all([
    import("@/components/guardrails/GuardrailsHost.vue"),
    import("@/providers/SettingsContextProvider"),
  ]);
  if (hostCount() > 0) return;
  const app = createApp(GuardrailsHost);
  app.provide(SettingsContextStateKey, {
    settings: computed(() => runtimeSettings() ?? { clusters: [] }),
  } as never);
  app.mount(document.body.appendChild(document.createElement("div")));
}

async function typedConfirm(request: Omit<TypedConfirmRequest, "id">): Promise<boolean> {
  settle(false);
  await ensureHost();
  return openTypedConfirm(request);
}

const targetLine = (target: GuardTarget, scoped: boolean) => {
  const kind = target.kind?.toLowerCase();
  const ref = target.name
    ? kind ? `${kind}/${target.name}` : target.name
    : kind || "object";
  return scoped && target.namespace ? `${ref} (${target.namespace})` : ref;
};

const LIST_LIMIT = 10;

/* ------------------------------------------------------------ guard -- */

/**
 * Runs the guardrails for `kind` on `targets`; resolves true when the
 * action may run. `confirm`: the app's own confirmation, shown when no
 * typed confirmation is needed.
 */
export async function guard(
  kind: ActionKind,
  targets: GuardTarget[],
  options: { confirm?: () => boolean | Promise<boolean> } = {}
): Promise<boolean> {
  const clusters = new Map<string, ResolvedCluster>();
  for (const target of targets) {
    const cluster = guardedCluster(target.context, target.kubeConfig);
    clusters.set(cluster.key, cluster);
  }
  const resolved = [...clusters.values()];
  const kinds = new Set(targets.map((target) => target.kind ?? ""));
  const decision = decideMany(kind, resolved, {
    count: targets.length,
    resourceName: targets[0]?.name,
    resourceKind: kinds.size === 1 ? [...kinds][0] || undefined : undefined,
  });

  if (!decision.allowed) {
    const blocked = resolved.find((cluster) => isBlocked(kind, cluster));
    if (blocked) readOnlyToast(blocked);
    return false;
  }

  if (decision.confirm === "typed" && decision.phrase) {
    const verb = verbOf(kind);
    const scoped =
      clusters.size > 1 || new Set(targets.map((target) => target.namespace)).size > 1;
    const lines = targets.slice(0, LIST_LIMIT).map((target) => targetLine(target, scoped));
    if (targets.length > LIST_LIMIT) lines.push(`… and ${targets.length - LIST_LIMIT} more`);
    return typedConfirm({
      title: `${verb} ${targets.length > 1 ? decision.phrase : lines[0] ?? decision.phrase}?`,
      // Protected clusters first.
      clusters: [...resolved].sort((a, b) => Number(b.protected) - Number(a.protected)),
      targets: lines,
      phrase: decision.phrase,
      verb,
      destructive: effectOf(kind) === "destructive",
      requireDryRun: decision.requireDryRun,
    });
  }

  return options.confirm ? await options.confirm() : true;
}

/**
 * The app's simple confirmation dialog as a promise (true: confirmed;
 * dismissing it leaves the promise pending, so nothing runs).
 */
export function confirmDialog(
  spawnDialog: (dialog: BaseDialogInterface) => void,
  dialog: Omit<BaseDialogInterface, "buttons"> & {
    confirmLabel: string;
    variant?: DialogButtonInterface["variant"];
  }
): Promise<boolean> {
  const { confirmLabel, variant, ...rest } = dialog;
  return new Promise((resolve) => {
    spawnDialog({
      ...rest,
      buttons: [
        {
          label: "Cancel",
          variant: "ghost",
          handler: (open) => {
            open.close();
            resolve(false);
          },
        },
        {
          label: confirmLabel,
          variant,
          handler: (open) => {
            open.close();
            resolve(true);
          },
        },
      ],
    });
  });
}
