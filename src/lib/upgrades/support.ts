/*
 * Whether a cluster's Kubernetes minor is still supported where it runs,
 * from the endoflife.date snapshot bundled with the app (data/
 * platforms.json, refreshed by scripts/update-upgrade-data.mjs). Pure.
 *
 * - Amazon EKS: standard support, then extended support at an extra fee;
 *   at the end of that EKS upgrades the control plane itself.
 * - Azure AKS: standard support, then long-term support on the Premium tier.
 * - Google GKE: standard support; GKE upgrades clusters at its end.
 * - Anything else: upstream Kubernetes' maintenance window.
 */
import data from "./data/platforms.json";
import type { ProviderId } from "@/lib/clusters/provider";
import type { StatusTone } from "@/components/ui/status/tones";
import { DAY_MS, dateMs, dayText, relativeDays } from "@/lib/health/checks/days";
import { compareMinor, minorOf, minorsBetween } from "./versions";

export type Platform = "eks" | "gke" | "aks" | "kubernetes";

/* A cluster this close to the end of support is worth a word. */
export const SOON_MS = 90 * DAY_MS;

interface Release {
  cycle: string;
  released: string | null;
  support: string | null;
  extended: string | null;
}

const PLATFORMS = data.platforms as Record<Platform, { label: string; page: string; releases: Release[] }>;

export const PLATFORM_LABELS: Record<Platform, string> = {
  eks: "Amazon EKS",
  gke: "Google GKE",
  aks: "Azure AKS",
  kubernetes: "Kubernetes",
};

export interface PlatformHints {
  /** The API server's gitVersion ("v1.31.4-eks-2d5f260"). */
  version?: string | null;
  /** Where the kubeconfig says it runs. */
  provider?: ProviderId | null;
  /** Labels of one of its nodes. */
  nodeLabels?: Record<string, string> | null;
}

/**
 * EKS and GKE stamp their builds into the version; AKS labels its nodes.
 * The kubeconfig's provider covers the rest (an AKS cluster seen before its
 * nodes are listed).
 */
export function platformOf(hints: PlatformHints): Platform {
  const version = hints.version ?? "";
  if (/-eks-/.test(version)) return "eks";
  if (/-gke\./.test(version)) return "gke";
  const labels = hints.nodeLabels ?? {};
  if (Object.keys(labels).some((key) => key.startsWith("kubernetes.azure.com/"))) return "aks";
  if (hints.provider === "aws") return "eks";
  if (hints.provider === "gcp") return "gke";
  if (hints.provider === "azure") return "aks";
  return "kubernetes";
}

export type SupportPhase = "supported" | "ending" | "extended" | "ended" | "newer";

export interface Support {
  platform: Platform;
  /** "1.31". */
  minor: string;
  phase: SupportPhase;
  tone: StatusTone;
  /** "Supported until Dec 2, 2026", "Extended support ends in 26 days". */
  headline: string;
  /** One quiet sentence more, when there is something to add. */
  detail: string | null;
  /** End of standard support (epoch ms), when known. */
  supportEnds: number | null;
  /** End of extended / long-term support (epoch ms), when the platform has it. */
  extendedEnds: number | null;
  /** The newest minor the platform offers. */
  latest: string;
  /** Minors between this one and the newest. */
  behind: number;
  /** Where the dates come from. */
  page: string;
}

const EXTENDED_COPY: Partial<Record<Platform, { name: string; note: string; after: string }>> = {
  eks: {
    name: "Extended support",
    note: "Extended support costs extra.",
    after: "After that, EKS upgrades the control plane itself.",
  },
  aks: {
    name: "Long-term support",
    note: "Long-term support needs the Premium tier.",
    after: "After that, AKS no longer supports it.",
  },
};

/** The support status of `version` on `platform`; null when it isn't a version. */
export function supportOf(platform: Platform, version: string | null | undefined, now = Date.now()): Support | null {
  const minor = minorOf(version);
  if (!minor) return null;
  const { releases, page } = PLATFORMS[platform];
  const latest = releases[0]?.cycle ?? minor;
  const behind = Math.max(0, minorsBetween(minor, latest));
  const base = { platform, minor, latest, behind, page };
  const release = releases.find((r) => r.cycle === minor);
  const name = platform === "kubernetes" ? "Upstream support" : "Support";

  if (!release) {
    if (compareMinor(minor, latest) > 0) {
      return {
        ...base,
        phase: "newer",
        tone: "muted",
        headline: "Newer than the support dates JET Pilot knows",
        detail: null,
        supportEnds: null,
        extendedEnds: null,
      };
    }
    return {
      ...base,
      phase: "ended",
      tone: "destructive",
      headline: "Out of support",
      detail: `${minor} is older than every version ${PLATFORM_LABELS[platform]} still lists.`,
      supportEnds: null,
      extendedEnds: null,
    };
  }

  const supportEnds = dateMs(release.support);
  const extendedEnds = dateMs(release.extended);
  const extended = EXTENDED_COPY[platform];
  const dates = { supportEnds, extendedEnds };

  if (supportEnds === null || now < supportEnds - SOON_MS) {
    return {
      ...base,
      ...dates,
      phase: "supported",
      tone: "success",
      headline: supportEnds === null ? "Supported" : `Supported until ${dayText(supportEnds)}`,
      detail: null,
    };
  }
  if (now < supportEnds) {
    return {
      ...base,
      ...dates,
      phase: "ending",
      tone: "warning",
      headline: `${extended ? "Standard support" : name} ends ${relativeDays(supportEnds, now)}`,
      detail: extended && extendedEnds
        ? `${extended.name} runs until ${dayText(extendedEnds)}. ${extended.note}`
        : `On ${dayText(supportEnds)}.`,
    };
  }
  if (extended && extendedEnds !== null && now < extendedEnds) {
    const soon = now >= extendedEnds - SOON_MS;
    return {
      ...base,
      ...dates,
      phase: "extended",
      tone: soon ? "destructive" : "warning",
      headline: soon
        ? `${extended.name} ends ${relativeDays(extendedEnds, now)}`
        : `${extended.name} until ${dayText(extendedEnds)}`,
      detail: `Standard support ended ${dayText(supportEnds)}. ${soon ? extended.after : extended.note}`,
    };
  }
  const end = extendedEnds !== null && extendedEnds > supportEnds ? extendedEnds : supportEnds;
  return {
    ...base,
    ...dates,
    phase: "ended",
    tone: "destructive",
    headline: `Out of support since ${dayText(end)}`,
    detail: platform === "gke" ? "GKE upgrades clusters past their end of support itself." : null,
  };
}

export interface SupportBadge {
  text: string;
  title: string;
}

/**
 * The quiet badge of a Clusters hub row: only within 90 days of the end of
 * (standard) support, or past it.
 */
export function supportBadge(support: Support | null): SupportBadge | null {
  if (!support) return null;
  const title = [`${PLATFORM_LABELS[support.platform]} ${support.minor}: ${support.headline}.`, support.detail]
    .filter(Boolean)
    .join(" ");
  switch (support.phase) {
    case "ending":
      return { text: "Support ends soon", title };
    case "extended":
      return { text: support.platform === "eks" ? "Extended support" : "Out of standard support", title };
    case "ended":
      return { text: "Out of support", title };
    default:
      return null;
  }
}

/** The next minor the platform offers after `minor`, if any. */
export function nextMinorOn(platform: Platform, minor: string): string | null {
  const newer = PLATFORMS[platform].releases.filter((r) => compareMinor(r.cycle, minor) > 0);
  return newer.length ? newer[newer.length - 1]!.cycle : null;
}
