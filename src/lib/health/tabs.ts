/* The tabs of the Health page (see @/views/health/HealthPage.vue). */
export const HEALTH_TABS = [
  { id: "problems", label: "Problems" },
  { id: "risks", label: "Risks" },
  { id: "upgrades", label: "Upgrades" },
  { id: "changes", label: "Changes" },
] as const;

export type HealthTab = (typeof HEALTH_TABS)[number]["id"];

/** What every tab works on: the active contexts and their namespaces. */
export interface HealthTarget {
  context: string;
  kubeConfig: string;
  /** ["all"] = every namespace. */
  namespaces: string[];
}
