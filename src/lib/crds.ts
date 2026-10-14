/*
 * Printer columns of custom resources: the additionalPrinterColumns of the
 * served version of a kind's CustomResourceDefinition, for the generic
 * resource table.
 *
 * Why the CRD and not the Table API (`as=Table`): rows come from the
 * backend watch as full objects. Evaluating the CRD's JSONPaths on those rows
 * keeps every column live with the watch for free; the Table API would need
 * a second list (or watch) per kind that drifts from the watched rows.
 *
 * Why one CRD by name and not the whole list: CRD lists carry every OpenAPI
 * schema (tens of MB on clusters with many operators); one CRD is fetched
 * when its list is opened, cached per context, and revalidated in the
 * background when the context's discovery changes (a CRD installed or
 * upgraded).
 */
import { shallowRef, watch, type Ref } from "vue";
import { kubeGet, type KubeTarget } from "./kubeApi";
import {
  flattenResources,
  groupRank,
  useDiscovery,
  type DiscoveredResource,
} from "./discovery";
import { isBuiltInGroup } from "./apiGroups";
import type { PrinterColumn } from "@/components/tables/printerColumns";

/** A CRD's name: `<plural>.<group>`. */
export const crdName = (resource: Pick<DiscoveredResource, "name" | "group">) =>
  `${resource.name}.${resource.group}`;

interface CrdColumn {
  name?: string;
  jsonPath?: string;
  /* apiextensions.k8s.io/v1beta1 */
  JSONPath?: string;
  type?: string;
  priority?: number;
  description?: string;
}

/**
 * The printer columns of `version` (apiextensions/v1: per version; v1beta1:
 * one list for all versions), falling back to the storage version.
 */
export function crdPrinterColumns(crd: any, version: string): PrinterColumn[] {
  const versions: any[] = Array.isArray(crd?.spec?.versions) ? crd.spec.versions : [];
  const served =
    versions.find((v) => v?.name === version) ??
    versions.find((v) => v?.storage) ??
    versions[0];
  const columns: CrdColumn[] =
    served?.additionalPrinterColumns ?? crd?.spec?.additionalPrinterColumns ?? [];
  return columns
    .filter((c) => c?.name && (c.jsonPath ?? c.JSONPath))
    .map((c) => ({
      name: c.name!,
      jsonPath: (c.jsonPath ?? c.JSONPath)!,
      ...(c.type ? { type: c.type } : {}),
      ...(c.priority ? { priority: c.priority } : {}),
      ...(c.description ? { description: c.description } : {}),
    }));
}

/**
 * The resource a list route means: `plural` or `plural.group`, with the
 * kind; the core group and built-in groups win over CRDs with the same
 * plural, like the backend's watch resolution (and kubectl).
 */
export function resolveListResource(
  resources: readonly DiscoveredResource[],
  resource: string,
  kind?: string
): DiscoveredResource | undefined {
  const lower = resource.trim().toLowerCase();
  const dot = lower.indexOf(".");
  const plural = dot < 0 ? lower : lower.slice(0, dot);
  const group = dot < 0 ? undefined : lower.slice(dot + 1);
  const candidates = resources
    .filter((r) => !r.name.includes("/"))
    .filter((r) => group === undefined || r.group === group)
    .sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group)
    );
  const wanted = kind?.toLowerCase();
  return (
    candidates.find((r) => r.name === plural && (!wanted || r.kind.toLowerCase() === wanted)) ??
    candidates.find((r) => r.name === plural) ??
    candidates.find((r) => r.kind.toLowerCase() === (wanted || plural))
  );
}

/* ---------------------------------------------------------- cache -- */

interface Entry {
  /** Discovery fetch time the columns were loaded against. */
  stamp: number;
  columns: PrinterColumn[];
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<PrinterColumn[]>>();
const MAX_ENTRIES = 200;

const cacheKey = (target: KubeTarget, resource: DiscoveredResource) =>
  [target.kubeConfig ?? "", target.context, crdName(resource), resource.version].join("\u0000");

/** Cached columns (possibly stale), without fetching. */
export function cachedPrinterColumns(
  target: KubeTarget,
  resource: DiscoveredResource
): PrinterColumn[] | undefined {
  return cache.get(cacheKey(target, resource))?.columns;
}

/**
 * The printer columns of a custom resource; fetched when not cached or
 * cached against an older discovery (`stamp`). A missing CRD (aggregated
 * APIs) or a failed request has no columns.
 */
export function loadPrinterColumns(
  target: KubeTarget,
  resource: DiscoveredResource,
  stamp = 0,
  get: typeof kubeGet = kubeGet
): Promise<PrinterColumn[]> {
  const key = cacheKey(target, resource);
  const cached = cache.get(key);
  if (cached && cached.stamp >= stamp) return Promise.resolve(cached.columns);
  const running = inFlight.get(key);
  if (running) return running;

  const promise = get(
    target,
    `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crdName(resource)}`
  )
    .then((crd) => crdPrinterColumns(crd, resource.version))
    .catch(() => cached?.columns ?? [])
    .then((columns) => {
      cache.delete(key);
      cache.set(key, { stamp, columns });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return columns;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Printer columns for the list of `resource` / `kind` in the primary
 * context, while `enabled` (kinds without hand-written columns). Cached
 * columns show right away and are revalidated when discovery changes.
 */
export function usePrinterColumns(options: {
  resource: () => string | undefined;
  kind: () => string | undefined;
  enabled: () => boolean;
  context: Ref<string>;
  kubeConfig: Ref<string>;
}): Ref<PrinterColumn[]> {
  const columns = shallowRef<PrinterColumn[]>([]);
  const discovery = useDiscovery(options.context, options.kubeConfig);
  let generation = 0;

  watch(
    () =>
      [
        options.enabled(),
        options.resource(),
        options.kind(),
        options.context.value,
        options.kubeConfig.value,
        discovery.snapshot.value,
      ] as const,
    async ([enabled, name, kind, context, kubeConfig, snapshot]) => {
      const current = ++generation;
      const resource =
        enabled && name && context
          ? resolveListResource(flattenResources(snapshot), name, kind)
          : undefined;
      if (!resource || isBuiltInGroup(resource.group)) {
        columns.value = [];
        return;
      }
      const target = { context, kubeConfig };
      columns.value = cachedPrinterColumns(target, resource) ?? [];
      const loaded = await loadPrinterColumns(target, resource, snapshot?.fetchedAt ?? 0);
      if (current === generation) columns.value = loaded;
    },
    { immediate: true }
  );

  return columns;
}
