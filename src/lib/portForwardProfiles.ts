/**
 * Saved port-forward profiles: a port forward that can be started again with
 * one click (sidebar, command palette, workspaces) and optionally starts
 * automatically when JET Pilot starts.
 */

export interface PortForwardSpec {
  kubeConfig: string;
  context: string;
  namespace: string;
  objectType: "pod" | "deployment" | "service";
  objectName: string;
  objectPort: number;
  localPort: number;
  address: string;
}

export interface PortForwardProfile {
  /** Derived from the spec: one profile per forward. */
  id: string;
  name: string;
  spec: PortForwardSpec;
  autoStart: boolean;
}

const OBJECT_TYPES = ["pod", "deployment", "service"];

export function profileId(spec: PortForwardSpec): string {
  return [
    spec.kubeConfig,
    spec.context,
    spec.namespace,
    `${spec.objectType}/${spec.objectName}:${spec.objectPort}`,
    `${spec.address}:${spec.localPort}`,
  ].join("|");
}

export function defaultProfileName(spec: PortForwardSpec): string {
  return `${spec.objectName}:${spec.objectPort} → ${spec.localPort}`;
}

/** The spec part of a (running) port forward. */
export function toSpec(forward: PortForwardSpec): PortForwardSpec {
  return {
    kubeConfig: forward.kubeConfig,
    context: forward.context,
    namespace: forward.namespace,
    objectType: forward.objectType,
    objectName: forward.objectName,
    objectPort: forward.objectPort,
    localPort: forward.localPort,
    address: forward.address,
  };
}

export function createProfile(
  spec: PortForwardSpec,
  options: { name?: string; autoStart?: boolean } = {}
): PortForwardProfile {
  const clean = toSpec(spec);
  return {
    id: profileId(clean),
    name: options.name?.trim() || defaultProfileName(clean),
    spec: clean,
    autoStart: !!options.autoStart,
  };
}

/** Whether `forward` (running or starting) is an instance of `profile`. */
export function isProfileRunning(
  profile: PortForwardProfile,
  forwards: PortForwardSpec[]
): boolean {
  return forwards.some((forward) => profileId(toSpec(forward)) === profile.id);
}

/** Auto-start profiles that are not running yet (e.g. after a reload). */
export function profilesToAutoStart(
  profiles: PortForwardProfile[],
  forwards: PortForwardSpec[]
): PortForwardProfile[] {
  return profiles.filter(
    (profile) => profile.autoStart && !isProfileRunning(profile, forwards)
  );
}

/** Adds or replaces (same id) a profile, keeping the order. */
export function upsertProfile(
  profiles: PortForwardProfile[],
  profile: PortForwardProfile
): PortForwardProfile[] {
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index === -1) return [...profiles, profile];
  const next = [...profiles];
  next.splice(index, 1, profile);
  return next;
}

const isPort = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value < 65536;

/** Validates stored profiles; drops invalid ones and recomputes ids. */
export function parseProfiles(value: unknown): PortForwardProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: PortForwardProfile[] = [];
  for (const raw of value) {
    const spec = raw?.spec;
    if (
      !spec ||
      typeof spec.context !== "string" ||
      typeof spec.kubeConfig !== "string" ||
      typeof spec.namespace !== "string" ||
      typeof spec.objectName !== "string" ||
      typeof spec.address !== "string" ||
      !OBJECT_TYPES.includes(spec.objectType) ||
      !isPort(spec.objectPort) ||
      !isPort(spec.localPort)
    ) {
      continue;
    }
    const profile = createProfile(spec, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      autoStart: raw.autoStart === true,
    });
    if (!profiles.some((p) => p.id === profile.id)) profiles.push(profile);
  }
  return profiles;
}
