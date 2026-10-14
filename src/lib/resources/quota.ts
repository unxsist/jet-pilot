/*
 * ResourceQuotas and LimitRanges in words (pure): each quota line as used
 * of hard with a label people read ("CPU requests", "Load balancers"), and
 * limit ranges as defaults and bounds.
 */
import { parseCpu, parseMemory } from "@/components/tables/metrics";
import { formatBytes, formatCores } from "@/lib/metrics/units";

export interface QuotaLine {
  key: string;
  label: string;
  used: number;
  hard: number;
  usedText: string;
  hardText: string;
}

const LABELS: Record<string, string> = {
  "requests.cpu": "CPU requests",
  cpu: "CPU requests",
  "limits.cpu": "CPU limits",
  "requests.memory": "Memory requests",
  memory: "Memory requests",
  "limits.memory": "Memory limits",
  "requests.storage": "Storage",
  "requests.ephemeral-storage": "Ephemeral storage",
  "limits.ephemeral-storage": "Ephemeral storage limits",
  pods: "Pods",
  services: "Services",
  "services.loadbalancers": "Load balancers",
  "services.nodeports": "Node ports",
  persistentvolumeclaims: "Volume claims",
  secrets: "Secrets",
  configmaps: "ConfigMaps",
  replicationcontrollers: "Replication controllers",
  resourcequotas: "Quotas",
};

function label(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const count = /^count\/([^.]+)/.exec(key);
  if (count) return count[1]!.charAt(0).toUpperCase() + count[1]!.slice(1);
  const classStorage = /^(.+)\.storageclass\.storage\.k8s\.io\/requests\.storage$/.exec(key);
  if (classStorage) return `Storage (${classStorage[1]})`;
  return key;
}

function amount(key: string, value: unknown): { value: number; text: string } {
  if (/(^|\.)cpu$/.test(key)) {
    const m = parseCpu(value);
    return { value: m, text: formatCores(m) };
  }
  if (/(memory|storage)$/.test(key)) {
    const b = parseMemory(value);
    return { value: b, text: formatBytes(b) };
  }
  const n = Number(value ?? 0);
  return { value: n, text: String(n) };
}

/** Every line of a quota, the fullest first. */
export function quotaLines(quota: any): QuotaLine[] {
  const hard = quota?.status?.hard ?? quota?.spec?.hard ?? {};
  const used = quota?.status?.used ?? {};
  return Object.keys(hard)
    .map((key) => {
      const h = amount(key, hard[key]);
      const u = amount(key, used[key] ?? 0);
      return { key, label: label(key), used: u.value, hard: h.value, usedText: u.text, hardText: h.text };
    })
    .sort((a, b) => (b.hard ? b.used / b.hard : 0) - (a.hard ? a.used / a.hard : 0));
}

export interface LimitLine {
  label: string;
  value: string;
}

const pair = (values: Record<string, string> | undefined) =>
  values
    ? [values.cpu && `${formatCores(parseCpu(values.cpu))} CPU`, values.memory && `${formatBytes(parseMemory(values.memory))} memory`]
        .filter(Boolean)
        .join(", ")
    : "";

/** A LimitRange's entries in words, per type (Container, Pod, PVC). */
export function limitRangeLines(limitRange: any): { type: string; lines: LimitLine[] }[] {
  return (limitRange?.spec?.limits ?? []).map((limit: any) => {
    const lines: LimitLine[] = [];
    if (limit.type === "PersistentVolumeClaim") {
      if (limit.min?.storage) lines.push({ label: "At least", value: formatBytes(parseMemory(limit.min.storage)) });
      if (limit.max?.storage) lines.push({ label: "At most", value: formatBytes(parseMemory(limit.max.storage)) });
    } else {
      if (pair(limit.defaultRequest)) lines.push({ label: "Default request", value: pair(limit.defaultRequest) });
      if (pair(limit.default)) lines.push({ label: "Default limit", value: pair(limit.default) });
      if (pair(limit.min)) lines.push({ label: "At least", value: pair(limit.min) });
      if (pair(limit.max)) lines.push({ label: "At most", value: pair(limit.max) });
    }
    const type = limit.type === "PersistentVolumeClaim" ? "Volume claims" : `${limit.type ?? "Container"}s`;
    return { type, lines };
  });
}
