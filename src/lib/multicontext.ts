import { Kubernetes } from "@/services/Kubernetes";

type ContextTagged<T> = T & {
  metadata: NonNullable<T extends { metadata?: infer M } ? M : never> & {
    context: string;
    kubeConfig: string;
  };
};

/**
 * Runs `kubectl get <resource> -o json` for a single context across the given
 * namespaces (`["all"]` means all namespaces) and returns the items tagged
 * with the context + kubeconfig they were fetched from, so row actions target
 * the right cluster.
 *
 * Namespace scopes are fetched in parallel. kubectl ignores `--namespace` for
 * cluster-scoped resources (nodes, persistent volumes, ...), so selecting
 * several namespaces would list them once per namespace: items are
 * de-duplicated by uid.
 */
export async function kubectlGetForContext<T extends { metadata?: any }>(
  resource: string,
  context: string,
  kubeConfig: string,
  namespaces: string[]
): Promise<ContextTagged<T>[]> {
  const scopes: (string | null)[] = namespaces.includes("all")
    ? [null]
    : namespaces;

  const results = await Promise.all(
    scopes.map(async (namespace) => {
      const args = ["get", resource, "-o", "json", "--context", context];
      if (kubeConfig) {
        args.push("--kubeconfig", kubeConfig);
      }
      if (namespace) {
        args.push("--namespace", namespace);
      } else {
        args.push("--all-namespaces");
      }

      return (JSON.parse(await Kubernetes.kubectl(args)).items || []) as T[];
    })
  );

  const seen = new Set<string>();
  const items: ContextTagged<T>[] = [];
  for (const item of results.flat()) {
    const uid = item.metadata?.uid;
    if (uid) {
      if (seen.has(uid)) continue;
      seen.add(uid);
    }

    items.push({
      ...item,
      metadata: { ...item.metadata, context, kubeConfig },
    } as ContextTagged<T>);
  }

  return items;
}
