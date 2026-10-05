/**
 * Where the resource graph gets its objects from: the shared API discovery
 * (which kinds exist) and, per kind, a live WatchHub subscription or the
 * kubectl fallback. Pure helpers (no Vue, no IO) - unit tested.
 */
import type { DiscoverySnapshot } from "./discovery";
import { flattenResources } from "./discovery";
import {
  DiscoveredResource,
  GraphObject,
  dedupeResources,
  selectGraphResources,
} from "./clusterGraph";

/** The graphable resources of a discovery snapshot, in GRAPH_RESOURCES order. */
export function graphResourcesOf(
  snapshot: DiscoverySnapshot | null | undefined
): DiscoveredResource[] {
  return selectGraphResources(
    dedupeResources(
      flattenResources(snapshot).map((resource) => ({
        name: resource.name,
        group: resource.group,
        kind: resource.kind,
        namespaced: resource.namespaced,
      }))
    )
  );
}

/*
 * Namespace scopes of one kind: a watcher per namespace when a few are
 * selected (works with namespace-scoped RBAC), one all-namespaces watcher
 * otherwise (the rows are filtered to the selection).
 */
export const MAX_NAMESPACE_SCOPES = 4;

export function namespaceTargets(
  resource: Pick<DiscoveredResource, "namespaced">,
  namespaces: string[]
): string[] {
  if (resource.namespaced === false) return ["all"];
  if (namespaces.length === 0 || namespaces.length > MAX_NAMESPACE_SCOPES) {
    return ["all"];
  }
  return [...namespaces].sort();
}

/* ------------------------------------------------------------ secrets -- */

/*
 * Secrets are listed metadata-only: kubectl evaluates this template, so
 * secret values never reach the webview. One line per Secret, tab
 * separated; labels as JSON (older kubectl versions print `map[k:v]`).
 * The Helm release annotation names the application of chart secrets.
 */
export const SECRET_METADATA_TEMPLATE =
  "jsonpath=" +
  "{range .items[*]}" +
  [
    "{.metadata.uid}",
    "{.metadata.namespace}",
    "{.metadata.name}",
    "{.type}",
    "{.metadata.resourceVersion}",
    "{.metadata.creationTimestamp}",
    "{.metadata.labels}",
    "{.metadata.annotations.meta\\.helm\\.sh/release-name}",
  ].join('{"\\t"}') +
  '{"\\n"}{end}';

export const SECRET_METADATA_FIELDS = 8;

/** kubectl arguments listing the Secrets of one namespace (null = all). */
export function secretMetadataArgs(
  context: string,
  kubeConfig: string,
  namespace: string | null
): string[] {
  const args = [
    "get",
    "secrets",
    "--context",
    context,
    "-o",
    SECRET_METADATA_TEMPLATE,
    "--request-timeout=30s",
  ];
  if (kubeConfig) args.push("--kubeconfig", kubeConfig);
  if (namespace) args.push("--namespace", namespace);
  else args.push("--all-namespaces");
  return args;
}

/** Parses `{...}` (JSON) or `map[k:v k2:v2]` (old kubectl) label output. */
export function parseLabelOutput(value: string): Record<string, string> {
  const text = value.trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  const match = /^map\[(.*)\]$/.exec(text);
  if (!match) return {};
  const labels: Record<string, string> = {};
  for (const pair of match[1].split(" ")) {
    const separator = pair.indexOf(":");
    if (separator > 0) labels[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return labels;
}

/**
 * Rows of SECRET_METADATA_TEMPLATE output: Secrets with metadata and type,
 * never `data` / `stringData`.
 */
export function parseSecretMetadata(
  output: string,
  tag: { context: string; kubeConfig: string }
): GraphObject[] {
  const secrets: GraphObject[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < SECRET_METADATA_FIELDS) continue;
    const [uid, namespace, name, type, resourceVersion, created, labels, release] =
      fields;
    if (!name) continue;
    const annotations = release
      ? { "meta.helm.sh/release-name": release }
      : undefined;
    secrets.push({
      apiVersion: "v1",
      kind: "Secret",
      type: type || "Opaque",
      metadata: {
        uid: uid || undefined,
        name,
        namespace: namespace || undefined,
        resourceVersion: resourceVersion || undefined,
        // kubectl prints the RFC 3339 string (the model types it as Date).
        creationTimestamp: (created || undefined) as unknown as Date,
        labels: parseLabelOutput(labels),
        ...(annotations ? { annotations } : {}),
        context: tag.context,
        kubeConfig: tag.kubeConfig,
      },
    });
  }
  return secrets;
}

/** Whether a resource is listed metadata-only (never watched in full). */
export const isMetadataOnly = (resource: DiscoveredResource) =>
  resource.group === "" && resource.name === "secrets";

/* Secrets Helm keeps its release history in: big, never graphed. */
export const isHelmReleaseSecret = (object: GraphObject) =>
  object.kind === "Secret" &&
  String(object.type || "").startsWith("helm.sh/release");

/**
 * Prepares rows of a kubectl list for the graph: kind filled in, Helm
 * release secrets dropped, managed fields stripped, context tags added.
 */
export function prepareListed(
  items: GraphObject[],
  resource: DiscoveredResource,
  tag: { context: string; kubeConfig: string }
): GraphObject[] {
  const result: GraphObject[] = [];
  for (const item of items) {
    if (!item?.metadata) continue;
    // kubectl lists do not always carry the kind of their items.
    item.kind = item.kind || resource.kind;
    if (isHelmReleaseSecret(item)) continue;
    if (item.kind === "Secret") {
      // Never keep secret values around, whatever path listed them.
      delete item.data;
      delete item.stringData;
    }
    delete item.metadata.managedFields;
    item.metadata.context = tag.context;
    item.metadata.kubeConfig = tag.kubeConfig;
    result.push(item);
  }
  return result;
}
