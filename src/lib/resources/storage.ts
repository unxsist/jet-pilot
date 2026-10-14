/*
 * Storage in words (pure): access modes, reclaim policies, binding modes
 * and the pods that use a claim.
 */

const ACCESS_MODES: Record<string, string> = {
  ReadWriteOnce: "Read-write by one node",
  ReadOnlyMany: "Read-only by many nodes",
  ReadWriteMany: "Read-write by many nodes",
  ReadWriteOncePod: "Read-write by one pod",
};

export const accessModeWords = (modes: string[] | undefined): string =>
  (modes ?? []).map((mode) => ACCESS_MODES[mode] ?? mode).join(", ") || "–";

export const RECLAIM_WORDS: Record<string, string> = {
  Delete: "Deleted together with its claim",
  Retain: "Kept after its claim is deleted",
  Recycle: "Wiped and reused after its claim is deleted",
};

export const BINDING_WORDS: Record<string, string> = {
  Immediate: "Volumes are created as soon as a claim asks",
  WaitForFirstConsumer: "Volumes are created once a pod uses the claim, in that pod's zone",
};

export const DEFAULT_CLASS_ANNOTATIONS = [
  "storageclass.kubernetes.io/is-default-class",
  "storageclass.beta.kubernetes.io/is-default-class",
];

export const isDefaultClass = (storageClass: any) =>
  DEFAULT_CLASS_ANNOTATIONS.some((key) => storageClass?.metadata?.annotations?.[key] === "true");

/** Pods (in the claim's namespace) with a volume from the claim. */
export function podsUsingClaim(claim: any, pods: any[]): any[] {
  const name = claim?.metadata?.name;
  const namespace = claim?.metadata?.namespace;
  return pods.filter(
    (pod) =>
      pod?.metadata?.namespace === namespace &&
      (pod?.spec?.volumes ?? []).some(
        (volume: any) =>
          volume.persistentVolumeClaim?.claimName === name ||
          // Generic ephemeral volumes: the claim is named <pod>-<volume>.
          (volume.ephemeral && `${pod.metadata?.name}-${volume.name}` === name)
      )
  );
}

/** Where a persistent volume's data lives, in words. */
export function volumeSource(volume: any): { kind: string; detail?: string } {
  const spec = volume?.spec ?? {};
  if (spec.csi) return { kind: `CSI (${spec.csi.driver})`, detail: spec.csi.volumeHandle };
  if (spec.hostPath) return { kind: "Host path", detail: spec.hostPath.path };
  if (spec.local) return { kind: "Local disk", detail: spec.local.path };
  if (spec.nfs) return { kind: "NFS", detail: `${spec.nfs.server}:${spec.nfs.path}` };
  if (spec.awsElasticBlockStore) return { kind: "AWS EBS", detail: spec.awsElasticBlockStore.volumeID };
  if (spec.gcePersistentDisk) return { kind: "GCE persistent disk", detail: spec.gcePersistentDisk.pdName };
  if (spec.azureDisk) return { kind: "Azure disk", detail: spec.azureDisk.diskName };
  const other = Object.keys(spec).find((key) => typeof spec[key] === "object" && !["capacity", "claimRef", "nodeAffinity", "accessModes", "mountOptions"].includes(key));
  return { kind: other ?? "Unknown" };
}
