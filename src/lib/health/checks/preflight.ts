/*
 * The Drain action's pre-flight: what the drain will run into on these
 * nodes (src/actions/nodes.ts), from their pods and the clusters'
 * disruption budgets. Quick or nothing: the confirmation never waits long.
 */
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { drainBlockers } from "./workloads";

const WAIT_MS = 2000;

interface DrainNode {
  name: string;
  context: string;
  kubeConfig?: string;
}

export async function drainWarnings(nodes: DrainNode[]): Promise<string[]> {
  const check = Promise.all(
    nodes.map(async (node) => {
      const target = { context: node.context, kubeConfig: node.kubeConfig || undefined };
      const [pods, pdbs] = await Promise.all([
        kubeGet<{ items?: any[] }>(target, apiPath({ apiVersion: "v1", resource: "pods", query: { fieldSelector: `spec.nodeName=${node.name}` } })),
        kubeGet<{ items?: any[] }>(target, apiPath({ apiVersion: "policy/v1", resource: "poddisruptionbudgets" })),
      ]);
      return drainBlockers(pods?.items ?? [], pdbs?.items ?? []);
    })
  ).then((lists) => [...new Set(lists.flat())]);
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), WAIT_MS));
  return Promise.race([check.catch(() => []), timeout]);
}
