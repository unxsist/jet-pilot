/**
 * Status tones map Kubernetes-ish states onto the semantic status tokens.
 * Pure TS (no Vue) so tables can use the class helpers in column `meta.class`
 * callbacks and it can be unit tested.
 */
export type StatusTone =
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "muted"
  | "primary";

/** Text colour, e.g. for a status cell: `text-success`. */
export const statusTextClass: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  muted: "text-muted-foreground",
  primary: "text-link",
};

/** Solid fill, e.g. for a dot: `bg-success`. */
export const statusDotClass: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  muted: "bg-muted-foreground/60",
  primary: "bg-primary",
};

/** Soft pill: tinted background + text-grade colour (AA in both themes). */
export const statusSoftClass: Record<StatusTone, string> = {
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/20 bg-warning/10 text-warning",
  destructive: "border-destructive/20 bg-destructive/10 text-destructive",
  info: "border-info/20 bg-info/10 text-info",
  muted: "border-border bg-muted text-muted-foreground",
  primary: "border-primary/20 bg-primary/10 text-link",
};

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // Healthy / done
  running: "success",
  ready: "success",
  active: "success",
  available: "success",
  bound: "success",
  deployed: "success",
  healthy: "success",
  true: "success",
  succeeded: "muted",
  completed: "muted",
  complete: "muted",
  superseded: "muted",
  released: "muted",

  // In progress / degraded
  pending: "warning",
  containercreating: "warning",
  podinitializing: "warning",
  init: "warning",
  terminating: "warning",
  progressing: "warning",
  "pending-install": "warning",
  "pending-upgrade": "warning",
  "pending-rollback": "warning",
  uninstalling: "warning",
  notready: "warning",
  schedulingdisabled: "warning",
  suspended: "warning",

  // Failure
  failed: "destructive",
  error: "destructive",
  crashloopbackoff: "destructive",
  imagepullbackoff: "destructive",
  errimagepull: "destructive",
  invalidimagename: "destructive",
  createcontainerconfigerror: "destructive",
  createcontainererror: "destructive",
  runcontainererror: "destructive",
  oomkilled: "destructive",
  evicted: "destructive",
  lost: "destructive",
  uninstalled: "destructive",
  false: "destructive",

  // Neutral
  unknown: "muted",
};

/**
 * Best-effort mapping of a status/phase/reason string to a tone.
 * Unknown values fall back to `fallback` (default `muted`).
 */
export function statusTone(
  status: string | null | undefined,
  fallback: StatusTone = "muted"
): StatusTone {
  if (!status) return fallback;
  const key = status.replace(/[\s_]/g, "").toLowerCase();
  if (key in TONE_BY_STATUS) return TONE_BY_STATUS[key];
  if (key.startsWith("init:")) {
    return /(error|backoff|crash)/.test(key) ? "destructive" : "warning";
  }
  if (/(backoff|error|fail|oom)/.test(key)) return "destructive";
  return fallback;
}
