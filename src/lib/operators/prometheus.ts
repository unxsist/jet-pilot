/*
 * Prometheus Operator: what a ServiceMonitor / PodMonitor scrapes, and the
 * rules of a PrometheusRule, in words. Pure, unit tested.
 */
import { selectorInWords } from "./format";

/** "Services app=web in payments", "Pods with any labels in all namespaces". */
export function monitorTargetInWords(monitor: any): string {
  const what = monitor?.kind === "PodMonitor" ? "Pods" : "Services";
  const selector = selectorInWords(monitor?.spec?.selector);
  const namespaces = monitor?.spec?.namespaceSelector;
  const where = namespaces?.any
    ? " in all namespaces"
    : namespaces?.matchNames?.length
      ? ` in ${namespaces.matchNames.join(", ")}`
      : "";
  return `${what} ${selector === "everything" ? "with any labels" : selector}${where}`;
}

/** Endpoints: "http-metrics every 30s", "/metrics on 9090". */
export function monitorEndpoints(monitor: any): string[] {
  const endpoints: any[] = monitor?.spec?.endpoints ?? monitor?.spec?.podMetricsEndpoints ?? [];
  return endpoints.map((endpoint) => {
    const port = endpoint?.port ?? endpoint?.targetPort ?? "";
    const path = endpoint?.path && endpoint.path !== "/metrics" ? ` ${endpoint.path}` : "";
    const every = endpoint?.interval ? ` every ${endpoint.interval}` : "";
    return `${port}${path}${every}`.trim() || "default endpoint";
  });
}

export interface RuleSummary {
  groups: number;
  alerts: number;
  records: number;
}

export function ruleSummary(rule: any): RuleSummary {
  const groups: any[] = rule?.spec?.groups ?? [];
  let alerts = 0;
  let records = 0;
  for (const group of groups) {
    for (const r of group?.rules ?? []) {
      if (r?.alert) alerts++;
      else if (r?.record) records++;
    }
  }
  return { groups: groups.length, alerts, records };
}

/** "12 alerts, 2 recording rules". */
export function rulesInWords(rule: any): string {
  const { alerts, records } = ruleSummary(rule);
  const parts: string[] = [];
  if (alerts) parts.push(`${alerts} alert${alerts === 1 ? "" : "s"}`);
  if (records) parts.push(`${records} recording rule${records === 1 ? "" : "s"}`);
  return parts.join(", ") || "No rules";
}

export interface AlertRule {
  name: string;
  severity?: string;
  for?: string;
  summary?: string;
  expr: string;
}

export interface RuleGroup {
  name: string;
  interval?: string;
  alerts: AlertRule[];
  records: string[];
}

export function ruleGroups(rule: any): RuleGroup[] {
  return (rule?.spec?.groups ?? []).map((group: any) => ({
    name: group?.name ?? "",
    interval: group?.interval,
    alerts: (group?.rules ?? [])
      .filter((r: any) => r?.alert)
      .map((r: any) => ({
        name: r.alert,
        severity: r.labels?.severity,
        for: r.for,
        summary: r.annotations?.summary ?? r.annotations?.description,
        expr: String(r.expr ?? ""),
      })),
    records: (group?.rules ?? []).filter((r: any) => r?.record).map((r: any) => r.record),
  }));
}
