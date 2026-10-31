/*
 * The Upgrades tab's findings in plain English: "Removed in 1.32", "Helm
 * can't upgrade karpenter until…", "4 nodes on 1.30". Pure.
 */
import { listWords, plural } from "@/lib/resources/format";
import { formatResourceKind } from "@/lib/utils";
import type { StatusTone } from "@/components/ui/status/tones";
import type { AddonStatus } from "./addons";
import type { ApiFinding } from "./apis";
import type { NodeVersions } from "./check";

const COMPONENTS: Record<string, string> = { "cert-manager": "cert-manager", istio: "Istio" };
const versionIn = (component: string, version: string) =>
  component === "k8s" ? version : `${COMPONENTS[component] ?? component} ${version}`;

export interface FindingWords {
  /** "Removed in 1.32", "Deprecated since 1.29". */
  when: string;
  tone: StatusTone;
  /** Where it's used and what to do, one sentence. */
  detail: string;
}

export function apiFindingWords(finding: ApiFinding): FindingWords {
  const { rule, source, apiVersion } = finding;
  const removed = rule.removed ? versionIn(rule.component, rule.removed) : null;
  const when =
    finding.state === "deprecated"
      ? removed
        ? `Deprecated, removed in ${removed}`
        : `Deprecated since ${versionIn(rule.component, rule.deprecated ?? "")}`
      : `Removed in ${removed}`;
  const use = rule.replacement ? ` Use ${rule.replacement}.` : "";
  let detail: string;
  if (source.type === "helm") {
    detail =
      finding.state === "removed"
        ? `Helm release ${source.release} still has ${apiVersion}, so helm upgrade fails until its stored manifest is fixed (helm mapkubeapis).`
        : `Helm release ${source.release} renders ${apiVersion}.${use}`;
  } else if (source.type === "applied") {
    detail =
      finding.state === "removed"
        ? `Last applied with ${apiVersion}: applying that manifest again fails.${use}`
        : `Last applied with ${apiVersion}.${use}`;
  } else {
    detail = `${source.manager} writes it with ${apiVersion}.${use}`;
  }
  const tone: StatusTone =
    finding.state === "removing" || (finding.state === "removed" && source.type === "helm")
      ? "warning"
      : "muted";
  return { when, tone, detail };
}

export interface ApiGroup extends FindingWords {
  key: string;
  /** "FlowSchema karpenter-leader-election", "2 FlowSchemas: a and b". */
  title: string;
}

/* Findings that only differ by object name read as one line. */
export function apiGroups(findings: ApiFinding[]): ApiGroup[] {
  const groups = new Map<string, { finding: ApiFinding; names: string[] }>();
  for (const finding of findings) {
    const { source } = finding;
    const from = source.type === "helm" ? `helm:${source.namespace}/${source.release}` : source.type === "manager" ? `manager:${source.manager}` : "applied";
    const key = [finding.kind, finding.apiVersion, finding.state, from, source.type === "helm" ? "" : finding.namespace ?? ""].join("|");
    const group = groups.get(key) ?? { finding, names: [] };
    group.names.push(finding.name);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, { finding, names }]) => {
    const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
    const title =
      names.length === 1
        ? `${finding.kind} ${names[0]}`
        : `${names.length} ${formatResourceKind(finding.kind)}: ${listWords(shown)}`;
    return { key, title, ...apiFindingWords(finding) };
  });
}

export function apisSummary(findings: ApiFinding[]): { text: string; tone: StatusTone } {
  if (!findings.length) return { text: "None in use", tone: "success" };
  const objects = new Set(findings.map((f) => `${f.kind}/${f.namespace ?? ""}/${f.name}`)).size;
  const urgent = findings.some((f) => apiFindingWords(f).tone === "warning");
  return {
    text: `${plural(objects, "object")} ${objects === 1 ? "uses" : "use"} deprecated or removed APIs`,
    tone: urgent ? "warning" : "muted",
  };
}

const needsUpdate = (addon: AddonStatus) => addon.phase === "ended" || addon.phase === "ending" || addon.phase === "retired";

export function addonsSummary(addons: AddonStatus[]): { text: string; tone: StatusTone } {
  if (!addons.length) return { text: "None of the well-known add-ons found", tone: "muted" };
  const attention = addons.filter(needsUpdate);
  if (!attention.length) return { text: `${plural(addons.length, "add-on")}, all supported`, tone: "success" };
  const names = listWords(attention.map((a) => a.label));
  return { text: `${names} ${attention.length === 1 ? "needs" : "need"} an update`, tone: "warning" };
}

export function nodesSummary(nodes: NodeVersions, next: string | null): { text: string; tone: StatusTone } {
  if (nodes.tooOld && next) {
    return {
      text: `${plural(nodes.tooOld, "node")} ${nodes.tooOld === 1 ? "is" : "are"} too old for ${next}: upgrade ${nodes.tooOld === 1 ? "it" : "them"} first`,
      tone: "warning",
    };
  }
  if (nodes.minors.length === 1) return { text: `${plural(nodes.total, "node")} on ${nodes.minors[0]!.minor}`, tone: "success" };
  const parts = nodes.minors.map((m, i) => (i === 0 ? `${plural(m.count, "node")} on ${m.minor}` : `${m.count} on ${m.minor}`));
  return { text: parts.join(", "), tone: "success" };
}
