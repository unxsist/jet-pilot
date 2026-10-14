/*
 * What a custom action will do for some objects (pure, unit tested): the
 * URL, the text, the argv and environment, the patch, plus what the user
 * reads in previews ("kubectl --context prod logs -f payments-api"). The
 * runner (./run.ts) executes a plan; Settings and the input form show it.
 */
import { cliMutationTarget } from "@/lib/guardrails/backstop";
import type { ActionKind } from "@/lib/guardrails/policy";
import {
  compileShell,
  containersOf,
  displayArgv,
  isPlaceholder,
  isWebUrl,
  parseTemplate,
  placeholders,
  powerShellVariable,
  quotePosix,
  renderArgs,
  renderText,
  renderUrl,
  resolveTyped,
  type ShellDialect,
} from "./template";
import type { CustomAction, TemplateContext } from "./types";

/** An object and the cluster it belongs to. */
export interface PlanItem {
  object: Record<string, any>;
  context: string;
  kubeConfig: string;
}

export interface PlanOptions {
  inputs: Record<string, string>;
  /** The container picked in the form (else the first one). */
  container?: string;
  dialect: ShellDialect;
  /** Shell started by `exec` without a command (Settings › Terminal). */
  containerShell: string;
}

export type PlanStep =
  | { type: "open"; url: string; valid: boolean }
  | { type: "copy"; text: string }
  /** A local process: a command in the system shell, or kubectl. */
  | { type: "process"; argv: string[]; env: Record<string, string> }
  /** No argv: the app's shell tab for the pod. */
  | { type: "exec"; argv: string[] | null; container: string }
  | { type: "patch"; patch: unknown };

export interface PlannedItem extends PlanItem {
  step: PlanStep;
  /** What the step does, for reading. */
  display: string;
}

export const contextOf = (item: PlanItem, options: Pick<PlanOptions, "inputs" | "container">): TemplateContext => ({
  object: item.object,
  context: item.context,
  kubeConfig: item.kubeConfig,
  inputs: options.inputs,
  container: options.container,
});

/* ---------------------------------------------------------- questions -- */

/** The run's templates (and the confirmation). */
function templatesOf(action: CustomAction): string[] {
  const { run } = action;
  const strings: string[] = [action.confirm];
  const collect = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  switch (run.type) {
    case "kubectl":
      strings.push(...run.args);
      break;
    case "exec":
      strings.push(run.command, run.container);
      break;
    case "patch":
      collect(run.patch);
      break;
    default:
      strings.push(run.template);
  }
  return strings;
}

/** The action needs to know which container (asked when there are several). */
export function usesContainer(action: CustomAction): boolean {
  if (action.run.type === "exec" && !action.run.container) return true;
  return templatesOf(action).some((template) =>
    placeholders(template).some((p) => p.ref.type === "field" && (p.ref.field === "container" || p.ref.field === "image"))
  );
}

/** Containers to choose from for these objects (none when there is nothing to choose). */
export function containerChoices(action: CustomAction, objects: Record<string, any>[]): string[] {
  if (!usesContainer(action)) return [];
  const names = new Set<string>();
  for (const object of objects) {
    const all = containersOf(object);
    // exec: running app containers, not init containers.
    const spec = object?.spec?.template?.spec ?? object?.spec;
    const regular = new Set((spec?.containers ?? []).map((c: { name: string }) => c.name));
    for (const container of all) {
      if (action.run.type !== "exec" || regular.has(container.name)) names.add(container.name);
    }
  }
  return names.size > 1 ? [...names] : [];
}

export const defaultInputs = (action: CustomAction): Record<string, string> =>
  Object.fromEntries(action.inputs.map((input) => [input.name, input.default ?? input.options?.[0] ?? ""]));

/* -------------------------------------------------------------- steps -- */

const NAMESPACE_FLAGS = /^(-n|--namespace|-A|--all-namespaces)(=|$)/;

/** kubectl argv with the object's --context / --kubeconfig / --namespace first. */
export function kubectlArgv(item: PlanItem, args: string[]): string[] {
  const argv = ["kubectl", "--context", item.context];
  if (item.kubeConfig) argv.push("--kubeconfig", item.kubeConfig);
  const namespace = item.object?.metadata?.namespace;
  if (namespace && !args.some((arg) => NAMESPACE_FLAGS.test(arg))) argv.push("--namespace", namespace);
  return [...argv, ...args];
}

/** kubectl changes the cluster with these arguments (rollout restart, patch, delete, ...). */
export const kubectlMutates = (argv: string[]): boolean => cliMutationTarget("kubectl", argv.slice(1)) !== null;

/** `kubectl exec` target: the pod, or `deployment/web` (kubectl picks one of its pods). */
const execTarget = (object: Record<string, any>) =>
  object.kind === "Pod" ? object.metadata.name : `${String(object.kind).toLowerCase()}/${object.metadata.name}`;

function renderPatch(value: unknown, ctx: TemplateContext, numberInputs: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    const parsed = parseTemplate(value);
    const [only] = parsed.segments;
    // A string that is one placeholder keeps the value's type (replicas: "{{input.replicas}}" → 3).
    if (parsed.segments.length === 1 && only && isPlaceholder(only)) return resolveTyped(only, ctx, numberInputs);
    return renderText(parsed, ctx);
  }
  if (Array.isArray(value)) return value.map((item) => renderPatch(item, ctx, numberInputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderPatch(item, ctx, numberInputs)]));
  }
  return value;
}

/** A local command line: POSIX sh with the values as positional parameters, or PowerShell. */
export function shellProcess(
  scripts: { script: string; values: string[] }[],
  dialect: ShellDialect,
  kubeConfig: string
): { argv: string[]; env: Record<string, string> } {
  const env: Record<string, string> = kubeConfig ? { KUBECONFIG: kubeConfig } : {};
  const script = scripts.map((part) => part.script).join("\n");
  const values = scripts.flatMap((part) => part.values);
  if (dialect === "posix") return { argv: ["/bin/sh", "-c", script, "sh", ...values], env };
  values.forEach((value, index) => (env[powerShellVariable(index + 1)] = value));
  return { argv: ["powershell.exe", "-NoProfile", "-Command", script], env };
}

export function planItem(action: CustomAction, item: PlanItem, options: PlanOptions): PlannedItem {
  const ctx = contextOf(item, options);
  const { run } = action;
  const planned = (step: PlanStep, display: string): PlannedItem => ({ ...item, step, display });
  switch (run.type) {
    case "open": {
      const url = renderUrl(run.template, ctx);
      return planned({ type: "open", url, valid: isWebUrl(url) }, url);
    }
    case "copy": {
      const text = renderText(run.template, ctx);
      return planned({ type: "copy", text }, text);
    }
    case "command": {
      const compiled = compileShell(run.template, ctx, options.dialect);
      return planned({ type: "process", ...shellProcess([compiled], options.dialect, item.kubeConfig) }, compiled.display);
    }
    case "kubectl": {
      const argv = kubectlArgv(item, renderArgs(run.args, ctx));
      return planned({ type: "process", argv, env: {} }, displayArgv(argv));
    }
    case "exec": {
      const containers = containersOf(item.object);
      const container =
        (run.container ? renderText(run.container, ctx) : "") || options.container || containers[0]?.name || "";
      const object = item.object;
      if (!run.command && object.kind === "Pod") {
        return planned(
          { type: "exec", argv: null, container },
          `kubectl exec -it ${quotePosix(object.metadata.name)} -c ${quotePosix(container)} -- ${options.containerShell}`
        );
      }
      const argv = [
        "kubectl",
        "exec",
        "--tty",
        "--stdin",
        execTarget(object),
        "--context",
        item.context,
        ...(object.metadata.namespace ? ["--namespace", object.metadata.namespace] : []),
        ...(item.kubeConfig ? ["--kubeconfig", item.kubeConfig] : []),
        ...(container ? ["-c", container] : []),
        "--",
      ];
      let shown = options.containerShell;
      if (run.command) {
        // The container's sh gets the values as positional parameters too.
        const compiled = compileShell(run.command, { ...ctx, container }, "posix");
        argv.push("sh", "-c", compiled.script, "sh", ...compiled.values);
        shown = compiled.display;
      } else argv.push(options.containerShell || "/bin/sh");
      const head = displayArgv(argv.slice(0, argv.indexOf("--") + 1));
      return planned({ type: "exec", argv, container }, `${head} ${shown}`);
    }
    case "patch": {
      const numbers = new Set(action.inputs.filter((input) => input.type === "number").map((input) => input.name));
      const patch = renderPatch(run.patch, ctx, numbers);
      return planned({ type: "patch", patch }, `Patch ${item.object.kind?.toLowerCase()}/${item.object.metadata?.name}: ${JSON.stringify(patch)}`);
    }
  }
}

export const planAction = (action: CustomAction, items: PlanItem[], options: PlanOptions): PlannedItem[] =>
  items.map((item) => planItem(action, item, options));

/**
 * Commands for several objects in one terminal tab: run one after another
 * (each object's values numbered on).
 */
export function sequenceInTerminal(
  action: CustomAction,
  items: PlanItem[],
  options: PlanOptions
): { argv: string[]; env: Record<string, string>; display: string } {
  const { run } = action;
  const scripts: { script: string; values: string[] }[] = [];
  const displays: string[] = [];
  let offset = 0;
  for (const item of items) {
    const ctx = contextOf(item, options);
    if (run.type === "command") {
      const compiled = compileShell(run.template, ctx, options.dialect, offset);
      scripts.push(compiled);
      displays.push(compiled.display);
      offset += compiled.values.length;
    } else if (run.type === "kubectl") {
      const argv = kubectlArgv(item, renderArgs(run.args, ctx));
      // Each argument (kubectl included) is a value: "$1" "$2" … / & ${env:JP_ARG_1} …
      const refs = argv.map((_, index) =>
        options.dialect === "posix"
          ? `"\${${offset + index + 1}}"`
          : `\${env:${powerShellVariable(offset + index + 1)}}`
      );
      scripts.push({ script: options.dialect === "posix" ? refs.join(" ") : `& ${refs.join(" ")}`, values: argv });
      displays.push(displayArgv(argv));
      offset += argv.length;
    }
  }
  const process = shellProcess(scripts, options.dialect, run.type === "command" ? items[0]?.kubeConfig ?? "" : "");
  return { ...process, display: displays.join("\n") };
}

/*
 * What the action does to a cluster, before it runs (menus hide changes on
 * read-only clusters). The runner checks again with the final arguments.
 */
export function customActionKind(action: CustomAction): ActionKind {
  if (action.mutates || action.run.type === "patch") return "custom-action";
  if (action.run.type === "kubectl" && cliMutationTarget("kubectl", ["--context", "-", ...action.run.args])) {
    return "custom-action";
  }
  return action.run.type === "exec" ? "exec" : "view";
}

/** The action changes the cluster: declared, a patch, or kubectl arguments that do. */
export function actionMutates(action: CustomAction, planned: PlannedItem[]): boolean {
  if (action.mutates || action.run.type === "patch") return true;
  return planned.some((item) => item.step.type === "process" && item.step.argv[0] === "kubectl" && kubectlMutates(item.step.argv));
}
