/**
 * Pure helpers for the cluster overview (resource graph).
 */

/** An API resource together with the group it was discovered in. */
export interface DiscoveredResource {
  /** Plural resource name, e.g. "gateways". */
  name: string;
  /** API group, "" for the core group. */
  group: string;
  kind: string;
}

/**
 * Fully-qualified resource name for kubectl ("gateways.networking.istio.io",
 * or just "pods" for the core group). Kinds are not unique across API groups
 * (Istio and Gateway API both define `Gateway`), resource.group is.
 */
export function qualifiedResourceName(resource: DiscoveredResource): string {
  return resource.group ? `${resource.name}.${resource.group}` : resource.name;
}

/** Keeps the first occurrence of every (group, resource) pair. */
export function dedupeResources<T extends DiscoveredResource>(
  resources: T[]
): T[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = qualifiedResourceName(resource);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

interface OwnedObject {
  metadata?: {
    uid?: string;
    ownerReferences?: { uid: string }[];
  };
}

/**
 * Index objects by the uid of each of their owners, so the children of an
 * object can be looked up in O(1) instead of scanning every object.
 */
export function buildOwnerIndex<T extends OwnedObject>(
  objects: T[]
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const object of objects) {
    for (const owner of object.metadata?.ownerReferences || []) {
      const children = index.get(owner.uid);
      if (children) {
        children.push(object);
      } else {
        index.set(owner.uid, [object]);
      }
    }
  }
  return index;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep
 * the order of `items`; a rejection is reported as a settled result and does
 * not stop the other items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await fn(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker
  );
  await Promise.all(workers);

  return results;
}
