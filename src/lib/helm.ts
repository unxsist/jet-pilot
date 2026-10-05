/*
 * Pure helpers for Helm release upgrades and history. Unit tested.
 */

export interface ChartRef {
  name: string;
  version: string;
}

/**
 * Splits the `chart` column of `helm list` (`<name>-<version>`) into name
 * and version: `kube-prometheus-stack-61.3.2`, `cert-manager-v1.15.1`,
 * `app-1.0.0-rc.1`.
 */
export function parseChartField(chart: string): ChartRef {
  const match = /^(.+)-(v?\d+\.\d+[\w.+-]*)$/.exec(chart.trim());
  return match
    ? { name: match[1], version: match[2] }
    : { name: chart.trim(), version: "" };
}

export interface ChartSearchResult {
  name: string; // repo/chart
  version: string;
  app_version?: string;
  description?: string;
}

/**
 * `helm search repo --versions -o json` results for `chartName`: exact chart
 * name matches only, grouped per repository reference.
 */
export function chartVersionsByRepo(
  results: ChartSearchResult[],
  chartName: string
): Map<string, ChartSearchResult[]> {
  const byRepo = new Map<string, ChartSearchResult[]>();
  for (const result of results) {
    const [, chart] = result.name.split("/");
    if (chart !== chartName) continue;
    const list = byRepo.get(result.name) ?? [];
    list.push(result);
    byRepo.set(result.name, list);
  }
  return byRepo;
}

/** Whether `helm plugin list` output lists the helm-diff plugin. */
export const hasDiffPlugin = (pluginList: string) =>
  pluginList
    .split(/\r?\n/)
    .slice(1)
    .some((line) => /^diff\s/.test(line.trim()));

/* `helm get values -o yaml` prints `null` for a release without values. */
export const normalizeValues = (values: string) =>
  values.trim() === "null" ? "" : values;

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

export const sortRevisionsDesc = (revisions: HelmRevision[]) =>
  [...revisions].sort((a, b) => b.revision - a.revision);

/** Tone of a Helm release status for badges. */
export function helmStatusTone(
  status: string
): "success" | "warning" | "destructive" | "muted" {
  if (status === "deployed") return "success";
  if (status === "failed") return "destructive";
  if (status.startsWith("pending")) return "warning";
  return "muted";
}

/** Strips ANSI colour codes (helm diff output). */
export const stripAnsi = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, "");
