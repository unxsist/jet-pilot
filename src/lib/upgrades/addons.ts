/*
 * The add-ons a cluster runs and whether their versions are still
 * supported, against the endoflife.date snapshot bundled with the app
 * (data/addons.json). Found from Helm releases first (the chart's app
 * version), then from well-known images and labels. Pure.
 */
import data from "./data/addons.json";
import type { StatusTone } from "@/components/ui/status/tones";
import { DAY_MS, dateMs, dayText, relativeDays } from "@/lib/health/checks/days";
import { compareMinor, minorOf, versionOf } from "./versions";

interface EolRelease {
  cycle: string;
  released: string | null;
  eol: string | null;
  latest: string | null;
}

const EOL = data.addons as Record<string, { label: string; page: string; releases: EolRelease[] }>;

interface AddonDef {
  id: string;
  label: string;
  /** Helm chart names. */
  charts: string[];
  /** Image repositories (without registry prefix ambiguity: matched at the end). */
  images: RegExp[];
  /** `app.kubernetes.io/part-of` of components that carry the version in `app.kubernetes.io/version`. */
  partOf?: string;
  retired?: { headline: string; detail: string };
}

export const ADDONS: AddonDef[] = [
  { id: "cert-manager", label: "cert-manager", charts: ["cert-manager"], images: [/\/cert-manager-controller$/] },
  {
    id: "ingress-nginx",
    label: "ingress-nginx",
    charts: ["ingress-nginx"],
    images: [/\/ingress-nginx\/controller$/],
    retired: {
      headline: "Retired in March 2026",
      detail: "It gets no more fixes, security fixes included. Move to Gateway API or another controller.",
    },
  },
  { id: "argo-cd", label: "Argo CD", charts: ["argo-cd"], images: [/\/argoproj\/argocd$/] },
  { id: "flux", label: "Flux", charts: ["flux2"], images: [/\/fluxcd\/source-controller$/], partOf: "flux" },
  { id: "karpenter", label: "Karpenter", charts: ["karpenter"], images: [/\/karpenter\/controller$/] },
  { id: "keda", label: "KEDA", charts: ["keda"], images: [/\/kedacore\/keda$/] },
  { id: "cilium", label: "Cilium", charts: ["cilium"], images: [/\/cilium\/cilium$/] },
  { id: "calico", label: "Calico", charts: ["tigera-operator", "calico"], images: [/\/calico\/node$/] },
  { id: "istio", label: "Istio", charts: ["istiod"], images: [/\/istio\/pilot$/] },
  { id: "kyverno", label: "Kyverno", charts: ["kyverno"], images: [/\/kyverno\/kyverno$/] },
  { id: "external-secrets", label: "External Secrets", charts: ["external-secrets"], images: [/\/external-secrets\/external-secrets$/] },
  { id: "metrics-server", label: "metrics-server", charts: ["metrics-server"], images: [/\/metrics-server\/metrics-server$/] },
];

/** "quay.io/cilium/cilium:v1.15.5@sha256:…" → repository and tag. */
export function splitImage(image: string): { repository: string; tag: string | null } {
  const bare = image.split("@")[0]!;
  const slash = bare.lastIndexOf("/");
  const colon = bare.lastIndexOf(":");
  return colon > slash ? { repository: bare.slice(0, colon), tag: bare.slice(colon + 1) } : { repository: bare, tag: null };
}

export interface HelmReleaseInfo {
  name: string;
  namespace: string;
  chart: string;
  chartVersion: string;
  appVersion: string;
}

export interface WorkloadInfo {
  kind: string;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  images: string[];
}

export interface FoundAddon {
  id: string;
  label: string;
  /** "1.15.1"; null when found without one. */
  version: string | null;
  /** Where it was found: "Helm release cert-manager in cert-manager". */
  where: string;
}

/** Repositories match with or without a registry ("docker.io/calico/node", "calico/node"). */
const imageMatches = (pattern: RegExp, repository: string) => pattern.test(`/${repository}`);

export function findAddons(releases: HelmReleaseInfo[], workloads: WorkloadInfo[]): FoundAddon[] {
  const found: FoundAddon[] = [];
  for (const addon of ADDONS) {
    const release = releases.find((r) => addon.charts.includes(r.chart));
    if (release) {
      found.push({
        id: addon.id,
        label: addon.label,
        version: versionOf(release.appVersion) ?? versionOf(release.chartVersion),
        where: `Helm release ${release.name} in ${release.namespace}`,
      });
      continue;
    }
    if (addon.partOf) {
      const labelled = workloads.find(
        (w) => w.labels["app.kubernetes.io/part-of"] === addon.partOf && versionOf(w.labels["app.kubernetes.io/version"])
      );
      if (labelled) {
        found.push({
          id: addon.id,
          label: addon.label,
          version: versionOf(labelled.labels["app.kubernetes.io/version"]),
          where: `${labelled.kind} ${labelled.name} in ${labelled.namespace}`,
        });
        continue;
      }
    }
    for (const workload of workloads) {
      const image = workload.images.find((i) => addon.images.some((p) => imageMatches(p, splitImage(i).repository)));
      if (!image) continue;
      // Flux's controllers are versioned on their own: only the labels say which Flux it is.
      const version = addon.partOf ? null : versionOf(splitImage(image).tag);
      found.push({ id: addon.id, label: addon.label, version, where: `${workload.kind} ${workload.name} in ${workload.namespace}` });
      break;
    }
  }
  return found;
}

export interface AddonStatus extends FoundAddon {
  minor: string | null;
  phase: "supported" | "ending" | "ended" | "retired" | "unknown";
  tone: StatusTone;
  /** "Out of support since Feb 3, 2025"; null when there's nothing to say. */
  headline: string | null;
  detail: string | null;
  page: string | null;
}

const SOON_MS = 90 * DAY_MS;

export function addonStatus(addon: FoundAddon, now = Date.now()): AddonStatus {
  const def = ADDONS.find((a) => a.id === addon.id);
  const minor = minorOf(addon.version);
  const base = { ...addon, minor, page: EOL[addon.id]?.page ?? null };
  if (def?.retired) {
    return { ...base, phase: "retired", tone: "warning", headline: def.retired.headline, detail: def.retired.detail };
  }
  const eol = EOL[addon.id];
  if (!eol || !minor) return { ...base, phase: "unknown", tone: "muted", headline: null, detail: null };
  const latest = eol.releases[0]!;
  const release = eol.releases.find((r) => r.cycle === minor);
  const newest = latest.cycle;
  const latestText = `The latest is ${latest.latest ?? newest}.`;
  if (!release) {
    if (compareMinor(minor, newest) > 0) return { ...base, phase: "unknown", tone: "muted", headline: null, detail: null };
    if (compareMinor(minor, eol.releases[eol.releases.length - 1]!.cycle) < 0) {
      return { ...base, phase: "ended", tone: "warning", headline: "Out of support", detail: latestText };
    }
    return { ...base, phase: "unknown", tone: "muted", headline: null, detail: null };
  }
  const ends = dateMs(release.eol);
  if (ends === null || now < ends - SOON_MS) {
    return { ...base, phase: "supported", tone: "success", headline: null, detail: null };
  }
  if (now < ends) {
    return { ...base, phase: "ending", tone: "warning", headline: `Support ends ${relativeDays(ends, now)}`, detail: latestText };
  }
  return { ...base, phase: "ended", tone: "warning", headline: `Out of support since ${dayText(ends)}`, detail: latestText };
}

/** Add-on minors the API table measures in (cert-manager, Istio), by add-on id. */
export function componentVersions(addons: FoundAddon[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const addon of addons) {
    const minor = minorOf(addon.version);
    if (minor && (addon.id === "cert-manager" || addon.id === "istio")) out[addon.id] = minor;
  }
  return out;
}
