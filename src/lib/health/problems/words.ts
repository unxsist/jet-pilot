/*
 * Kubernetes messages in a few plain words, for the Problems list (pure).
 * The full message stays available in the side panel; these only have to
 * say what's wrong at a glance. Anything unrecognised falls back to the
 * message itself, tidied up.
 */
import { sentence } from "@/lib/resources/format";

/* The first line, without a trailing period. */
const tidy = (message: string | undefined) =>
  sentence((message ?? "").split("\n")[0]!.replace(/\.\s*$/, ""));

/** A message as a short sentence, or `fallback` without one. */
export const messageWords = (message: string | undefined, fallback: string) => tidy(message) || fallback;

const EXIT_WORDS: Record<number, string> = {
  126: "Can't run its command",
  127: "Its command doesn't exist",
  137: "Killed",
  139: "Segmentation fault",
  143: "Stopped",
};

/** What an exit code means, when it's a well-known one: "Killed". */
export const exitMeaning = (code: number | undefined) => (code === undefined ? undefined : EXIT_WORDS[code]);

/** "Exits with code 1", "Killed (exit code 137)". */
export function exitWords(code: number | undefined): string {
  if (code === undefined) return "Keeps exiting";
  const meaning = EXIT_WORDS[code];
  return meaning ? `${meaning} (exit code ${code})` : `Exits with code ${code}`;
}

/** A CreateContainerConfigError message: what's missing. */
export function configWords(message: string | undefined): { label: string; short: string } {
  const text = message ?? "";
  const missing = /^(secret|configmap)s? "([^"]+)" not found/i.exec(text);
  if (missing) {
    const kind = missing[1]!.toLowerCase() === "secret" ? "Secret" : "ConfigMap";
    return { label: `Missing a ${kind}`, short: `${kind} ${missing[2]} doesn't exist` };
  }
  const key = /couldn't find key (\S+) in (Secret|ConfigMap) (?:[^/\s]+\/)?(\S+)/i.exec(text);
  if (key) return { label: "Missing a key", short: `${key[2]} ${key[3]} has no key ${key[1]}` };
  return { label: "Configuration error", short: tidy(text) || "A ConfigMap or Secret it needs is missing" };
}

const RESOURCE_WORDS: Record<string, string> = {
  cpu: "CPU",
  memory: "memory",
  "ephemeral-storage": "disk space",
  pods: "room for pods",
};

const resourceWords = (resource: string) => RESOURCE_WORDS[resource] ?? resource;

/* One reason of the scheduler ("4 Insufficient memory") in words. */
function schedulingReason(reason: string): string | null {
  const insufficient = /Insufficient ([\w./-]+)/.exec(reason);
  if (insufficient) return `No node has enough ${resourceWords(insufficient[1]!)}`;
  const taint = /untolerated taint \{?([^:}\s]+)/.exec(reason);
  if (taint) return `Nodes have a taint it doesn't tolerate (${taint[1]})`;
  if (/node affinity\/selector/.test(reason)) return "No node matches its node selector";
  if (/pod anti-affinity/.test(reason)) return "Its anti-affinity rules leave no node";
  if (/pod affinity/.test(reason)) return "No node runs the pods it must be near";
  if (/topology spread/.test(reason)) return "Its spread rules leave no node";
  if (/unbound immediate PersistentVolumeClaims/.test(reason)) return "Its volume claim isn't bound";
  if (/volume node affinity conflict/.test(reason)) return "Its volume is in another zone";
  if (/Too many pods/.test(reason)) return "Every node is full";
  if (/were unschedulable/.test(reason)) return "Its nodes are cordoned";
  if (/free ports/.test(reason)) return "No node has its host port free";
  if (/not-ready|NotReady/.test(reason)) return "Its nodes aren't ready";
  return null;
}

/**
 * The scheduler's reason in words: the reason most nodes give ("0/4 nodes
 * are available: 4 Insufficient memory." → "No node has enough memory").
 */
export function schedulingWords(message: string | undefined): string {
  const text = (message ?? "").split(/\.?\s*preemption:/)[0]!;
  const list = /nodes are available:\s*(.*)$/.exec(text)?.[1];
  if (list) {
    const reasons = list
      .replace(/\.$/, "")
      .split(/,\s*(?=\d+ )/)
      .map((part) => {
        const match = /^(\d+)\s+(.*)$/.exec(part.trim());
        return { count: match ? Number(match[1]) : 0, text: match ? match[2]! : part.trim() };
      })
      .sort((a, b) => b.count - a.count);
    for (const reason of reasons) {
      const words = schedulingReason(reason.text);
      if (words) return words;
    }
    if (reasons[0]?.text) return tidy(reasons[0].text);
  }
  return schedulingReason(text) ?? (tidy(text) || "No node can run it yet");
}

/** Why the kubelet evicted a pod ("The node was low on resource: memory."). */
export function evictionWords(message: string | undefined): string {
  const low = /low on resource: ([\w-]+)/.exec(message ?? "");
  if (low) return `The node ran low on ${resourceWords(low[1]!)}`;
  return tidy(message) || "The node ran out of resources";
}

/** A failing probe from an Unhealthy event ("Readiness probe failed: ..."). */
export function probeWords(message: string | undefined): { type: string; short: string } | null {
  const match = /^(Readiness|Liveness|Startup) probe (?:failed|errored):?\s*(.*)$/s.exec((message ?? "").trim());
  if (!match) return null;
  const [, type, rest = ""] = match;
  const status = /statuscode: (\d+)/.exec(rest);
  const detail = status
    ? `gets HTTP ${status[1]}`
    : /connection refused/.test(rest)
      ? "can't connect"
      : /deadline exceeded|timed? ?out|timeout/i.test(rest)
        ? "times out"
        : tidy(rest).replace(/^./, (c) => c.toLowerCase());
  return { type: type!, short: `${type} probe ${detail || "fails"}` };
}

/** A failed image pull ("Failed to pull image ...: not found"). */
export function pullWords(image: string, message: string | undefined): string {
  const text = message ?? "";
  if (/not ?found|manifest unknown|does not exist|failed to resolve reference/i.test(text)) return `${image} doesn't exist`;
  if (/unauthorized|denied|forbidden|403|401/i.test(text)) return `Not allowed to pull ${image}`;
  if (/no such host|i\/o timeout|connection refused/i.test(text)) return `Can't reach the registry of ${image}`;
  return image;
}

/** A failed mount or volume attach (FailedMount, FailedAttachVolume events). */
export function mountWords(message: string | undefined): string {
  const text = message ?? "";
  const missing = /(secret|configmap)s? "([^"]+)" not found/i.exec(text);
  if (missing) return `${missing[1]!.toLowerCase() === "secret" ? "Secret" : "ConfigMap"} ${missing[2]} doesn't exist`;
  if (/Multi-Attach/i.test(text)) return "Its volume is still attached to another node";
  if (/timed out waiting/i.test(text)) return "Its volumes didn't attach in time";
  return tidy(text.replace(/^MountVolume\.\w+ failed for volume "[^"]+"\s*:\s*/, "")) || "Its volumes can't be mounted";
}

/** Why a claim can't bind (ProvisioningFailed / ExternalProvisioning events). */
export function claimWords(message: string | undefined): string {
  const text = message ?? "";
  const storageClass = /storageclass(?:\.storage\.k8s\.io)? "([^"]+)" not found/i.exec(text);
  if (storageClass) return `Storage class ${storageClass[1]} doesn't exist`;
  if (/waiting for a volume to be created/i.test(text)) return "Waiting for its provisioner";
  if (/waiting for first consumer/i.test(text)) return "Waiting for a pod to use it";
  return tidy(text) || "No volume is bound to it yet";
}

/** Why a Deployment can't create pods (its ReplicaFailure condition). */
export function createWords(message: string | undefined): string {
  const text = message ?? "";
  if (/exceeded quota/i.test(text)) return "Over its namespace's resource quota";
  const account = /serviceaccount "([^"]+)" not found/i.exec(text);
  if (account) return `Service account ${account[1]} doesn't exist`;
  const webhook = /admission webhook "([^"]+)" denied/i.exec(text);
  if (webhook) return `Webhook ${webhook[1]} refuses its pods`;
  return tidy(text.replace(/^pods? "[^"]+" is forbidden:\s*/, "")) || "Its pods can't be created";
}

const PRESSURE: Record<string, { label: string; short: string }> = {
  MemoryPressure: { label: "Low on memory", short: "The kubelet may evict pods to free memory" },
  DiskPressure: { label: "Low on disk", short: "The kubelet may evict pods to free disk space" },
  PIDPressure: { label: "Too many processes", short: "It's close to its process limit" },
  NetworkUnavailable: { label: "Network unavailable", short: "Its network isn't set up" },
};

/** A node condition that is wrong when true, in words. */
export function nodeConditionWords(type: string, label: string, message: string | undefined) {
  return PRESSURE[type] ?? { label, short: tidy(message) || label };
}
