/*
 * Runs a custom action on objects: scope check, read-only check, the input
 * form, the guardrails (typed confirmation on protected clusters) or the
 * action's own confirmation, then the plan (./plan.ts). Loaded on first
 * use from the row menus, the side panel, the palette and shortcuts.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type as osType } from "@tauri-apps/plugin-os";
import { formatResourceKind as pluralize } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { describeRows, getResourceTabId, getResourceTabTitle } from "@/components/tables/identity";
import { cliErrorMessage, runCli } from "@/actions/command";
import { allowed, confirmDialog, guard, rowTargets } from "@/lib/guardrails/guard";
import type { ActionKind } from "@/lib/guardrails/policy";
import { apiPath, kubePatch } from "@/lib/kubeApi";
import { flattenResources, getDiscoveryService } from "@/lib/discovery";
import { runtimeSettings } from "@/lib/settings/runtime";
import { error as logError } from "@/lib/logger";
import { isPtyExitMessage, ptyOutput, type PtyMessage } from "@/lib/pty";
import { matchesScope } from "./scope";
import {
  actionMutates,
  containerChoices,
  contextOf,
  defaultInputs,
  planAction,
  sequenceInTerminal,
  type PlanItem,
  type PlannedItem,
  type PlanOptions,
} from "./plan";
import { renderText, type ShellDialect } from "./template";
import type { CustomAction } from "./types";

export interface RunHost {
  addTab: (id: string, title: string, component: unknown, props?: unknown, icon?: string) => void;
  spawnDialog: (dialog: any) => void;
  /** Objects without a context of their own (rare) belong to this one. */
  primary?: { context: string; kubeConfig: string };
}

/** At most this many browser tabs / terminal tabs from one run. */
const MAX_OPEN = 10;
const ERROR_TOAST_DURATION = 15000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

const dialect = (): ShellDialect => (osType() === "windows" ? "powershell" : "posix");
const containerShell = () => runtimeSettings()?.terminal?.containerShell?.trim() || "/bin/sh";
const nameOf = (item: PlanItem) => String(item.object.metadata?.name ?? "");
const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as any).message) : String(e);

/** The last lines of process output, without colours. */
const tail = (output: string, lines = 4) =>
  output.replace(ANSI, "").replace(/\r/g, "").trim().split("\n").slice(-lines).join("\n");

/* ------------------------------------------------------------- dialogs -- */

function prompt(
  host: RunHost,
  action: CustomAction,
  items: PlanItem[],
  containers: string[],
  mutates: boolean
): Promise<{ inputs: Record<string, string>; container?: string } | null> {
  return new Promise((done) => {
    host.spawnDialog({
      title: action.name,
      message: items.length > 1 ? `${items.length} objects` : action.description || getResourceTabTitle(items[0]!.object),
      component: defineAsyncComponent(() => import("@/views/dialogs/ActionPrompt.vue")),
      props: { action, items, containers, dialect: dialect(), containerShell: containerShell(), mutates, done },
      buttons: [],
    });
  });
}

/* The action's own confirmation (when the form didn't show it). */
function confirmRun(host: RunHost, action: CustomAction, items: PlanItem[], options: PlanOptions): Promise<boolean> {
  const text = renderText(action.confirm, contextOf(items[0]!, options));
  return confirmDialog(host.spawnDialog, {
    title: action.name,
    message: items.length > 1 ? `${text}\n\nOn ${items.length} objects:` : text,
    ...(items.length > 1
      ? {
          component: defineAsyncComponent(() => import("@/views/dialogs/ResourceList.vue")),
          props: { lines: describeRows(items.map((item) => item.object)) },
        }
      : {}),
    confirmLabel: action.run.type === "patch" ? "Apply" : "Run",
  });
}

/* ------------------------------------------------------------ runners -- */

const expandPanel = () => window.dispatchEvent(new Event("TabOrchestrator_Expand"));

function openTerminal(
  host: RunHost,
  action: CustomAction,
  title: string,
  props: { argv: string[]; env: Record<string, string>; display: string; context: string; kubeConfig: string },
  authorize: () => Promise<boolean>
) {
  host.addTab(
    `action_${action.id}_${Date.now().toString(36)}`,
    title,
    defineAsyncComponent(() => import("@/views/ActionTerminal.vue")),
    { ...props, authorize },
    "shell"
  );
  expandPanel();
}

/** A process without a terminal (create_tty_session, no tab): its exit code and output. */
function runHeadless(argv: string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const decoder = new TextDecoder();
    const channel = new Channel<PtyMessage>();
    channel.onmessage = (event) => {
      const bytes = ptyOutput(event);
      if (bytes) output += decoder.decode(bytes, { stream: true });
      else if (isPtyExitMessage(event)) resolve({ code: event.exitCode, output: event.error ? `${output}\n${event.error}` : output });
    };
    invoke<string>("create_tty_session", { initCommand: argv, env, rows: 40, cols: 160, onEvent: channel }).catch((e) =>
      resolve({ code: null, output: message(e) })
    );
  });
}

/* The plural resource of an object's kind, for its API path (discovery, else the English plural). */
function resourceOf(item: PlanItem): string {
  const kind = String(item.object.kind ?? "");
  const apiVersion = String(item.object.apiVersion ?? "v1");
  const group = apiVersion.includes("/") ? apiVersion.split("/")[0] : "";
  const found = flattenResources(getDiscoveryService().peek(item.context, item.kubeConfig)).find(
    (resource) => resource.kind === kind && resource.group === group
  );
  return found?.name ?? pluralize(kind.toLowerCase());
}

/** One summary for a background run on several objects. */
function report(action: CustomAction, results: { item: PlanItem; ok: boolean; detail: string }[]) {
  const failed = results.filter((result) => !result.ok);
  const succeeded = results.filter((result) => result.ok);
  if (succeeded.length) {
    const single = results.length === 1 ? succeeded[0]! : null;
    toast({
      title: single ? `${action.name} · ${nameOf(single.item)}` : `${action.name} · ${succeeded.length} objects`,
      description: single ? single.detail || "Done" : succeeded.map((result) => nameOf(result.item)).join(", "),
      variant: "success",
      autoDismiss: true,
    });
  }
  if (failed.length) {
    toast({
      title:
        failed.length === 1
          ? `${action.name} failed on ${nameOf(failed[0]!.item)}`
          : `${action.name} failed on ${failed.length} objects`,
      description: failed
        .map((result) => (failed.length === 1 ? result.detail : `${nameOf(result.item)}: ${result.detail}`))
        .join("\n"),
      variant: "destructive",
      duration: ERROR_TOAST_DURATION,
    });
  }
}

async function execute(
  host: RunHost,
  action: CustomAction,
  items: PlanItem[],
  planned: PlannedItem[],
  options: PlanOptions,
  authorize: () => Promise<boolean>
) {
  const { run } = action;
  switch (run.type) {
    case "open": {
      const invalid = planned.find((item) => item.step.type === "open" && !item.step.valid);
      if (invalid) {
        toast({ title: "That isn't a web address", description: invalid.display, variant: "destructive", duration: ERROR_TOAST_DURATION });
        return;
      }
      for (const item of planned.slice(0, MAX_OPEN)) {
        if (item.step.type === "open") await openExternal(item.step.url);
      }
      return;
    }
    case "copy": {
      const text = planned.map((item) => item.display).join("\n");
      await writeText(text);
      toast({
        title: planned.length > 1 ? `Copied ${planned.length} lines` : "Copied to the clipboard",
        description: text.length > 120 ? `${text.slice(0, 120)}…` : text,
        autoDismiss: true,
      });
      return;
    }
    case "command":
    case "kubectl": {
      if (!run.background) {
        const first = items[0]!;
        const title = items.length > 1 ? `${action.name} · ${items.length} objects` : `${action.name} · ${nameOf(first)}`;
        const process =
          items.length > 1
            ? sequenceInTerminal(action, items, options)
            : { ...(planned[0]!.step as { argv: string[]; env: Record<string, string> }), display: planned[0]!.display };
        openTerminal(host, action, title, { ...process, context: first.context, kubeConfig: first.kubeConfig }, authorize);
        return;
      }
      const running = toast({ title: `${action.name}…`, description: items.length > 1 ? `${items.length} objects` : nameOf(items[0]!) });
      const results = await Promise.all(
        planned.map(async (item) => {
          if (item.step.type !== "process") return { item, ok: false, detail: "" };
          if (item.step.argv[0] === "kubectl") {
            const result = await runCli("kubectl", item.step.argv.slice(1), { guarded: true });
            return { item, ok: result.code === 0, detail: result.code === 0 ? tail(result.stdout) : cliErrorMessage(result) };
          }
          const result = await runHeadless(item.step.argv, item.step.env);
          return {
            item,
            ok: result.code === 0,
            detail: tail(result.output) || (result.code === 0 ? "" : `Exited with code ${result.code ?? "unknown"}`),
          };
        })
      );
      running.dismiss();
      report(action, results);
      return;
    }
    case "exec": {
      for (const item of planned.slice(0, MAX_OPEN)) {
        if (item.step.type !== "exec") continue;
        const object = item.object;
        if (!item.step.argv) {
          // A shell in a pod: the app's own shell tab.
          const container = (object.spec?.containers ?? []).find((c: { name: string }) => c.name === (item.step as { container: string }).container);
          host.addTab(
            getResourceTabId("shell", object, container?.name),
            getResourceTabTitle(object, container?.name),
            defineAsyncComponent(() => import("@/views/Shell.vue")),
            { kubeConfig: item.kubeConfig, context: item.context, namespace: object.metadata.namespace ?? "", pod: object, container },
            "shell"
          );
          expandPanel();
          continue;
        }
        openTerminal(
          host,
          action,
          `${action.name} · ${nameOf(item)}`,
          { argv: item.step.argv, env: {}, display: item.display, context: item.context, kubeConfig: item.kubeConfig },
          authorize
        );
      }
      return;
    }
    case "patch": {
      const results = await Promise.all(
        planned.map(async (item) => {
          if (item.step.type !== "patch") return { item, ok: false, detail: "" };
          try {
            const path = apiPath({
              apiVersion: String(item.object.apiVersion ?? "v1"),
              resource: resourceOf(item),
              namespace: item.object.metadata?.namespace,
              name: item.object.metadata?.name,
            });
            await kubePatch({ context: item.context, kubeConfig: item.kubeConfig }, path, item.step.patch);
            return { item, ok: true, detail: "Patched" };
          } catch (e) {
            return { item, ok: false, detail: message(e) };
          }
        })
      );
      report(action, results);
      return;
    }
  }
}

/* ---------------------------------------------------------------- run -- */

/**
 * Runs `action` on `objects` (table rows or the side panel's object). Only
 * objects in its scope take part; several only when the action allows it.
 */
export async function runCustomAction(action: CustomAction, objects: Record<string, any>[], host: RunHost): Promise<void> {
  let items: PlanItem[] = objects
    .filter((object) => matchesScope(action, object, object?.metadata?.context || host.primary?.context))
    .map((object) => ({
      object,
      context: object.metadata?.context || host.primary?.context || "",
      kubeConfig: object.metadata?.kubeConfig || host.primary?.kubeConfig || "",
    }));
  if (items.length === 0) {
    toast({ title: `${action.name} doesn't apply here`, description: "None of the objects is in its scope." });
    return;
  }
  if (!action.scope.multiple) items = items.slice(0, 1);

  let options: PlanOptions = { inputs: defaultInputs(action), dialect: dialect(), containerShell: containerShell() };
  // Kubectl arguments are checked with the defaults first (the read-only check comes before the form)...
  const mutatesBefore = actionMutates(action, planAction(action, items, options));
  const targets = rowTargets(items.map((item) => ({ ...item.object, metadata: { ...item.object.metadata, context: item.context, kubeConfig: item.kubeConfig } })));
  if (mutatesBefore && !allowed("custom-action", targets)) return;

  const containers = containerChoices(action, items.map((item) => item.object));
  let confirmShown = false;
  if (action.inputs.length || containers.length) {
    const answer = await prompt(host, action, items, containers, mutatesBefore);
    if (!answer) return;
    options = { ...options, ...answer };
    confirmShown = !!action.confirm;
  }

  // ...and again with the answers (an input may be the verb).
  const planned = planAction(action, items, options);
  const mutates = mutatesBefore || actionMutates(action, planned);
  const kind: ActionKind = mutates ? "custom-action" : action.run.type === "exec" ? "exec" : "view";
  // Protected clusters: the typed confirmation names the action.
  const title = (subject: string) => `${action.name} on ${subject}?`;
  const authorize = async () =>
    kind === "custom-action"
      ? guard(kind, targets, { title, confirm: action.confirm ? () => confirmRun(host, action, items, options) : undefined })
      : action.confirm
        ? confirmRun(host, action, items, options)
        : true;

  const ok =
    kind === "custom-action"
      ? await guard(kind, targets, {
          title,
          confirm: action.confirm && !confirmShown ? () => confirmRun(host, action, items, options) : undefined,
        })
      : !action.confirm || confirmShown || (await confirmRun(host, action, items, options));
  if (!ok) return;

  try {
    await execute(host, action, items, planned, options, authorize);
  } catch (e) {
    logError(`Custom action ${action.id} failed: ${message(e)}`);
    toast({ title: `${action.name} failed`, description: message(e), variant: "destructive", duration: ERROR_TOAST_DURATION });
  }
}
