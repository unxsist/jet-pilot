/*
 * The open typed confirmation, rendered by GuardrailsHost. Kept apart from
 * guard.ts so the host (mounted at startup) stays tiny: the guard logic
 * loads with the first action that needs it.
 */
import { shallowRef } from "vue";
import type { ResolvedCluster } from "@/lib/clusters/meta";

export interface TypedConfirmRequest {
  id: number;
  title: string;
  clusters: ResolvedCluster[];
  /** One line per target. */
  targets: string[];
  phrase: string;
  verb: string;
  destructive: boolean;
  requireDryRun: boolean;
}

/** The open typed confirmation (GuardrailsHost renders it). */
export const pendingConfirm = shallowRef<TypedConfirmRequest | null>(null);
let settlePending: ((confirmed: boolean) => void) | null = null;
let nextId = 0;

/** Closes the open typed confirmation. */
export function settle(confirmed: boolean): void {
  const resolve = settlePending;
  settlePending = null;
  pendingConfirm.value = null;
  resolve?.(confirmed);
}

let hosts = 0;

export const hostCount = () => hosts;

/** GuardrailsHost calls this while mounted; returns the unregister function. */
export function registerHost(): () => void {
  hosts++;
  return () => {
    hosts--;
  };
}


/** Shows a typed confirmation; resolves with the user's answer. */
export function openTypedConfirm(request: Omit<TypedConfirmRequest, "id">): Promise<boolean> {
  return new Promise((resolve) => {
    settlePending = resolve;
    pendingConfirm.value = { ...request, id: ++nextId };
  });
}
