/*
 * "The kubectl equivalent" of what JET Pilot does (pure, unit tested): a
 * command line for an action, with the cluster flags (`--context`, `-n`,
 * `--kubeconfig`) only where they differ from what kubectl would use by
 * itself, and every value quoted for a POSIX shell.
 */

export type CommandProgram = "kubectl" | "helm";

export interface CommandTarget {
  context: string;
  kubeConfig?: string;
  /** Unset for cluster-scoped objects. */
  namespace?: string;
}

/** A command an action runs: its arguments without the cluster flags. */
export interface CommandSpec {
  program: CommandProgram;
  args: string[];
  target: CommandTarget;
}

/** What kubectl uses without flags, as far as JET Pilot knows. */
export interface KubectlDefaults {
  /** The kubeconfig files kubectl reads by itself ($KUBECONFIG, else ~/.kube/config). */
  kubeconfigs: string[];
  /** The current context of a kubeconfig ("" for the default files, merged). */
  currentContext: (kubeConfig: string) => string | null | undefined;
  /** A context's own namespace, if it sets one. */
  namespaceOf: (context: string, kubeConfig: string) => string | null | undefined;
}

/* Never needs quoting in POSIX shells, bash or zsh. */
const SAFE = /^[A-Za-z0-9_@%+:,./=-]+$/;

/** One argument for a POSIX shell: as is when safe, else single-quoted. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  // `=x` at the start of a word is a path lookup in zsh.
  if (SAFE.test(arg) && !arg.startsWith("=")) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const FLAGS: Record<CommandProgram, { context: string[]; kubeconfig: string[]; namespace: string[] }> = {
  kubectl: { context: ["--context"], kubeconfig: ["--kubeconfig"], namespace: ["--namespace", "-n"] },
  helm: { context: ["--kube-context"], kubeconfig: ["--kubeconfig"], namespace: ["--namespace", "-n"] },
};

/* JET Pilot's own settings, not part of what the command does. */
const APP_FLAGS = ["--request-timeout"];

/**
 * The spec of an argv as JET Pilot runs it: the cluster flags (both
 * `--flag value` and `--flag=value`) become the target, app-only flags
 * (`--request-timeout`) are dropped.
 */
export function commandFromArgv(program: CommandProgram, argv: readonly string[]): CommandSpec {
  const flags = FLAGS[program];
  const target: CommandTarget = { context: "" };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Everything after `--` belongs to the command run in the container.
    if (arg === "--") {
      args.push(...argv.slice(i));
      break;
    }
    const eq = arg.indexOf("=");
    const name = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = name !== arg ? arg.slice(eq + 1) : undefined;
    const value = () => inline ?? argv[++i] ?? "";
    if (flags.context.includes(name)) target.context = value();
    else if (flags.kubeconfig.includes(name)) target.kubeConfig = value();
    else if (flags.namespace.includes(name)) target.namespace = value();
    else if (APP_FLAGS.includes(name)) {
      if (inline === undefined) i++;
    } else args.push(arg);
  }
  return { program, args, target };
}

const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** The cluster flags kubectl (or helm) needs for `target`, given its defaults. */
export function clusterFlags(
  program: CommandProgram,
  target: CommandTarget,
  defaults: KubectlDefaults
): string[] {
  const flags = FLAGS[program];
  const kubeConfig = target.kubeConfig ?? "";
  const isDefaultFile =
    !kubeConfig ||
    defaults.kubeconfigs.some((path) => normalizePath(path) === normalizePath(kubeConfig));
  // Which file's current context applies: the default files' (merged), or this one's.
  const current = defaults.currentContext(isDefaultFile ? "" : kubeConfig);
  const namespace = target.namespace;
  const defaultNamespace = defaults.namespaceOf(target.context, kubeConfig) || "default";

  const result: string[] = [];
  if (namespace && namespace !== defaultNamespace) result.push("-n", namespace);
  if (target.context && target.context !== current) result.push(flags.context[0], target.context);
  if (!isDefaultFile) result.push(flags.kubeconfig[0], kubeConfig);
  return result;
}

/** The quoted words of the command line; the flags go before a `--`. */
export function commandWords(spec: CommandSpec, defaults: KubectlDefaults): string[] {
  const flags = clusterFlags(spec.program, spec.target, defaults);
  const split = spec.args.indexOf("--");
  const args =
    split < 0
      ? [...spec.args, ...flags]
      : [...spec.args.slice(0, split), ...flags, ...spec.args.slice(split)];
  return [spec.program, ...args].map(shellQuote);
}

/** The command line to paste into a terminal. */
export const commandLine = (spec: CommandSpec, defaults: KubectlDefaults): string =>
  commandWords(spec, defaults).join(" ");

/** A kubectl command for a table row (rows carry their context and kubeconfig). */
export const kubectlFor = (
  row: { metadata?: { context?: string; kubeConfig?: string; namespace?: string } },
  args: string[]
): CommandSpec => ({
  program: "kubectl",
  args,
  target: {
    context: row.metadata?.context ?? "",
    kubeConfig: row.metadata?.kubeConfig,
    namespace: row.metadata?.namespace,
  },
});

/* ---------------------------------------------------- action builders -- */

/*
 * Arguments of the actions that don't run kubectl themselves (they use the
 * API, or open a tab or dialog): what someone would type for the same.
 */

/* Groups whose kinds no add-on reuses: their kind alone is unambiguous. */
const BUILTIN_GROUPS = new Set(["", "apps", "batch", "autoscaling", "policy"]);

/**
 * An object's reference: `deployment/web`, or with the API group for
 * add-on kinds (`kustomization.kustomize.toolkit.fluxcd.io/apps`), whose
 * kind names other add-ons may use too.
 */
export function kindRef(object: {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string };
}): string {
  const version = object.apiVersion ?? "";
  const group = version.includes("/") ? version.slice(0, version.indexOf("/")) : "";
  const kind = (object.kind ?? "").toLowerCase();
  const qualified = BUILTIN_GROUPS.has(group) || group.endsWith(".k8s.io") ? kind : `${kind}.${group}`;
  return `${qualified}/${object.metadata?.name ?? ""}`;
}

export const logsArgs = (
  pod: string,
  options: { container?: string; previous?: boolean; follow?: boolean } = {}
) => [
  "logs",
  pod,
  ...(options.container ? ["-c", options.container] : ["--all-containers"]),
  ...(options.previous ? ["--previous"] : options.follow === false ? [] : ["-f"]),
];

/** Every pod of a workload: by its selector, each line prefixed with its pod. */
export const selectorLogsArgs = (selector: string, previous = false) => [
  "logs",
  "-l",
  selector,
  "--all-containers",
  "--prefix",
  ...(previous ? ["--previous"] : ["-f"]),
];

export const execArgs = (pod: string, container: string | undefined, shell = "sh") => [
  "exec",
  "-it",
  pod,
  ...(container ? ["-c", container] : []),
  "--",
  shell,
];

/* Ports below 1024 need root locally: 80 → 8080, like people usually pick. */
export const localPortFor = (remote: number) => (remote < 1024 ? remote + 8000 : remote);

export const portForwardArgs = (ref: string, ports: { local: number; remote: number | string }[]) => [
  "port-forward",
  ref,
  ...ports.map((p) => (String(p.local) === String(p.remote) ? String(p.local) : `${p.local}:${p.remote}`)),
];

export const scaleArgs = (ref: string, replicas: number) => ["scale", ref, `--replicas=${replicas}`];

/** A job name like the app's own (`nightly-manual-k3x9a`), unique per run. */
export const manualJobName = (name: string, now = Date.now()) =>
  `${name}-manual-${now.toString(36).slice(-5)}`;

/** `kubectl create job --from=cronjob/x <name>`. */
export const triggerCronJobArgs = (name: string, jobName = manualJobName(name)) => [
  "create",
  "job",
  `--from=cronjob/${name}`,
  jobName,
];

export const deletePodArgs = (name: string, force: boolean) => [
  "delete",
  "pod",
  name,
  ...(force ? ["--grace-period=0", "--force"] : []),
];

/** `kubectl annotate ref key=value --overwrite`; null removes (`key-`), like a merge patch. */
export const annotateArgs = (ref: string, annotations: Record<string, string | null | undefined>) => [
  "annotate",
  ref,
  ...Object.entries(annotations).flatMap(([key, value]) =>
    value === undefined ? [] : [value === null ? `${key}-` : `${key}=${value}`]
  ),
  "--overwrite",
];

/** `kubectl patch ref --type=merge -p '{…}'`. */
export const mergePatchArgs = (ref: string, patch: unknown) => [
  "patch",
  ref,
  "--type=merge",
  "-p",
  JSON.stringify(patch),
];
