/*
 * Pure helpers for workload operations (logs across pods, rollouts, debug).
 * No Vue / Tauri imports so they can be unit tested.
 */

export interface LabelSelectorRequirement {
  key: string;
  operator: string;
  values?: string[];
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

/**
 * kubectl `--selector` string for a LabelSelector, e.g.
 * `app=web,tier in (api,worker),!canary`. Empty for an empty selector
 * (which would match every pod: callers must not stream that).
 */
export function labelSelectorToString(
  selector: LabelSelector | null | undefined
): string {
  if (!selector) return "";

  const parts = Object.entries(selector.matchLabels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);

  for (const expression of selector.matchExpressions ?? []) {
    const values = [...(expression.values ?? [])].sort().join(",");
    switch (expression.operator) {
      case "In":
        parts.push(`${expression.key} in (${values})`);
        break;
      case "NotIn":
        parts.push(`${expression.key} notin (${values})`);
        break;
      case "Exists":
        parts.push(expression.key);
        break;
      case "DoesNotExist":
        parts.push(`!${expression.key}`);
        break;
    }
  }

  return parts.join(",");
}

/** Selector string for a plain label map (Service, ReplicationController). */
export const mapSelectorToString = (
  selector: Record<string, string> | null | undefined
): string => labelSelectorToString({ matchLabels: selector ?? {} });

interface ObjectLike {
  kind?: string;
  spec?: { selector?: unknown };
}

/** Kinds whose pods can be found through `spec.selector`. */
const LABEL_SELECTOR_KINDS = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
];
const MAP_SELECTOR_KINDS = ["Service", "ReplicationController"];

/**
 * Selector matching the pods of a workload / service, or null when the
 * object has no (usable) pod selector.
 */
export function workloadSelector(object: ObjectLike | null | undefined): string | null {
  if (!object?.kind) return null;

  let selector = "";
  if (LABEL_SELECTOR_KINDS.includes(object.kind)) {
    selector = labelSelectorToString(object.spec?.selector as LabelSelector);
  } else if (MAP_SELECTOR_KINDS.includes(object.kind)) {
    selector = mapSelectorToString(
      object.spec?.selector as Record<string, string>
    );
  }

  return selector || null;
}

/** `kind/name` reference as accepted by kubectl, lower-cased kind. */
export const objectRef = (kind: string, name: string) =>
  `${kind.toLowerCase()}/${name}`;

/**
 * Whether a kubectl object reference (`name`, `pod/name`,
 * `deployment/name`) points at a single pod.
 */
export const isPodRef = (object: string) =>
  !object.includes("/") || /^pods?\//i.test(object);

/** Pod name of a pod reference (`pod/web-0` -> `web-0`). */
export const podNameOf = (object: string) => object.replace(/^pods?\//i, "");

/* --------------------------------------------------------- kubectl args -- */

export interface ClusterTarget {
  context: string;
  namespace?: string;
  kubeConfig?: string;
}

/** `--context`, `--namespace`, `--kubeconfig` in flag=value form. */
export function clusterArgs(target: ClusterTarget): string[] {
  const args = [`--context=${target.context}`];
  if (target.namespace) args.push(`--namespace=${target.namespace}`);
  if (target.kubeConfig) args.push(`--kubeconfig=${target.kubeConfig}`);
  return args;
}

/** Helm uses `--kube-context` instead of `--context`. */
export function helmClusterArgs(target: ClusterTarget): string[] {
  const args = [`--kube-context=${target.context}`];
  if (target.namespace) args.push(`--namespace=${target.namespace}`);
  if (target.kubeConfig) args.push(`--kubeconfig=${target.kubeConfig}`);
  return args;
}

export const DEBUG_IMAGES = [
  {
    image: "busybox:1.36",
    label: "busybox",
    description: "Tiny shell with core utilities",
  },
  {
    image: "nicolaka/netshoot",
    label: "netshoot",
    description: "Network troubleshooting: dig, curl, tcpdump, iperf, …",
  },
  {
    image: "alpine:3.20",
    label: "alpine",
    description: "Small distro with a package manager (apk)",
  },
];

/**
 * argv for `kubectl debug` with an ephemeral container attached to `pod`,
 * sharing the process namespace of `target` (when given).
 */
export function kubectlDebugPodCommand(options: {
  pod: string;
  image: string;
  target?: string;
  cluster: ClusterTarget;
  shell?: string;
}): string[] {
  return [
    "kubectl",
    "debug",
    "--stdin",
    "--tty",
    options.pod,
    ...clusterArgs(options.cluster),
    `--image=${options.image}`,
    ...(options.target ? [`--target=${options.target}`] : []),
    "--profile=general",
    "--",
    options.shell?.trim() || "sh",
  ];
}

/**
 * argv for a shell on a node via `kubectl debug node/<node>`: a privileged
 * pod in the host namespaces with the node's filesystem at /host. With
 * `chroot` the shell runs in the host filesystem.
 */
export function kubectlNodeShellCommand(options: {
  node: string;
  image: string;
  cluster: ClusterTarget;
  chroot: boolean;
}): string[] {
  return [
    "kubectl",
    "debug",
    "--stdin",
    "--tty",
    `node/${options.node}`,
    ...clusterArgs(options.cluster),
    `--image=${options.image}`,
    "--profile=sysadmin",
    "--",
    ...(options.chroot ? ["chroot", "/host", "sh"] : ["sh"]),
  ];
}

/** Name of the pod `kubectl debug node/...` created, from its output. */
export function debugPodNameFromOutput(output: string): string | null {
  const match = /Creating debugging pod (\S+) with container/.exec(output);
  return match ? match[1] : null;
}

/** argv (without `kubectl`) copying between a container and a local path. */
export function kubectlCopyArgs(options: {
  direction: "download" | "upload";
  pod: string;
  namespace: string;
  container?: string;
  remotePath: string;
  localPath: string;
  cluster: ClusterTarget;
}): string[] {
  const remote = `${options.namespace}/${options.pod}:${options.remotePath}`;
  return [
    "cp",
    ...(options.direction === "download"
      ? [remote, options.localPath]
      : [options.localPath, remote]),
    ...(options.container ? [`--container=${options.container}`] : []),
    // The namespace is part of the remote spec; --namespace would be
    // redundant but --context / --kubeconfig are needed.
    ...clusterArgs({ ...options.cluster, namespace: undefined }),
  ];
}

/** Basename of a local or remote path (`/var/log/app.log` -> `app.log`). */
export const baseName = (path: string) =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
