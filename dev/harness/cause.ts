/*
 * The harness's likelyCause (wired in by vite.config.ts in place of
 * @/lib/changes/cause): `?scenario=problems-cause` answers from fixtures,
 * so the Problems panel can show a cause; every other scenario asks the
 * app's own implementation.
 */
import { likelyCause as appLikelyCause, type ChangeSummary, type LikelyCause } from "../../src/lib/changes/cause";

export * from "../../src/lib/changes/cause";

const scenario = localStorage.getItem("harness-scenario") || "default";
const minutesBefore = (since: string | undefined, minutes: number) =>
  new Date((since ? Date.parse(since) : Date.now()) - minutes * 60_000).toISOString();

const CAUSES: Record<string, (since?: string) => ChangeSummary> = {
  "checkout-api": (since) => ({
    at: minutesBefore(since, 12),
    object: { kind: "Deployment", name: "checkout-api", namespace: "checkout" },
    summary: "Image changed from checkout-api:v3.1.4 to checkout-api:v3.2.0.",
    by: "argocd-application-controller",
  }),
  "payments-worker": (since) => ({
    at: minutesBefore(since, 41),
    object: { kind: "ConfigMap", name: "payments-config", namespace: "payments" },
    summary: "ConfigMap payments-config changed: batchSize went from 1000 to 5000.",
    by: "kubectl-edit",
  }),
};

export const likelyCause: LikelyCause = async (target, object, since) => {
  if (scenario !== "problems-cause") return appLikelyCause(target, object, since);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const app = Object.keys(CAUSES).find((name) => object.name === name || object.name.startsWith(`${name}-`));
  return app ? CAUSES[app]!(since) : null;
};
