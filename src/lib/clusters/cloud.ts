/*
 * Cloud accounts and the live cluster catalog (src-tauri: connections,
 * AWS IAM Identity Center / profiles / access keys, EKS discovery). The
 * catalog lists every cluster a connected account can see; adding one
 * writes it into JET Pilot's kubeconfig.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ContextRef } from "@/lib/contextKey";
import type { LoginEvent } from "@/lib/auth/types";

export type CloudProvider = "aws";
export type ConnectionKind = "sso" | "profile" | "keys";

export interface ConnectionTarget {
  accountId: string;
  accountName?: string | null;
  roleName: string;
}

export interface CloudConnection {
  id: string;
  provider: CloudProvider;
  kind: ConnectionKind;
  label: string;
  identity?: string | null;
  sso?: { startUrl: string; region: string } | null;
  profile?: string | null;
  /** Home region (access keys, profiles). */
  region?: string | null;
  /** Empty: every enabled region. */
  regions: string[];
  targets: ConnectionTarget[];
  status: "signedIn" | "expired" | "signedOut" | "error";
  expiresAt?: number | null;
  message?: string | null;
  createdAt: number;
}

export type ConnectionSpec =
  | { kind: "sso"; label?: string; startUrl: string; region: string }
  | { kind: "profile"; label?: string; profile: string }
  | { kind: "keys"; label?: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string };

export const listConnections = () => invoke<CloudConnection[]>("connections_list");
export const createConnection = (spec: ConnectionSpec) => invoke<CloudConnection>("connection_create", { spec });
export const updateConnection = (id: string, patch: Partial<Pick<CloudConnection, "label" | "regions" | "targets">>) =>
  invoke<CloudConnection>("connection_update", { id, patch });
export const deleteConnection = (id: string, removeClusters: boolean) =>
  invoke<void>("connection_delete", { id, removeClusters });

/** Starts an IAM Identity Center sign-in (device code), streaming LoginEvents. */
export const awsSsoSignIn = (connectionId: string, channel: Channel<LoginEvent>) =>
  invoke<string>("aws_sso_sign_in", { connectionId, onEvent: channel });

/** Signs in to a profile that assumes a role with MFA, with a code from the device. */
export const awsMfaSignIn = (connectionId: string, code: string) =>
  invoke<CloudConnection>("aws_mfa_sign_in", { connectionId, code });

export interface AwsAccount {
  accountId: string;
  accountName: string;
  email?: string | null;
  roles: string[];
}
export const awsSsoAccounts = (connectionId: string) => invoke<AwsAccount[]>("aws_sso_accounts", { connectionId });

export interface AwsProfile {
  name: string;
  kind: "sso" | "assumeRole" | "static" | "credentialProcess" | "webIdentity" | "unknown";
  region?: string | null;
  ssoSession?: string | null;
  ssoStartUrl?: string | null;
  ssoRegion?: string | null;
  mfa: boolean;
}
export const awsProfiles = () => invoke<AwsProfile[]>("aws_profiles_list");
export const awsRegions = () => invoke<string[]>("aws_regions");

/* ----------------------------------------------------------- catalog -- */

export interface CatalogCluster {
  key: string;
  provider: CloudProvider;
  connectionId: string;
  accountId: string;
  accountName?: string | null;
  roleName?: string | null;
  region: string;
  name: string;
  version?: string | null;
  status?: string | null;
  endpoint?: string | null;
  createdAt?: number | null;
  state: "available" | "added" | "ignored" | "removed";
  addedContext?: ContextRef | null;
}

export type CatalogEvent =
  | {
      type: "progress";
      connectionId: string;
      /** "<account> · <region>", or "regions" while the enabled regions are listed. */
      scope: string;
      accountId?: string | null;
      accountName?: string | null;
      region?: string | null;
      state: "running" | "done" | "error";
      message?: string | null;
    }
  | { type: "clusters"; connectionId: string; clusters: CatalogCluster[] }
  | { type: "done"; refreshedAt: number };

export const catalogGet = () => invoke<{ clusters: CatalogCluster[]; refreshedAt?: number | null }>("catalog_get");

export function catalogRefresh(connectionIds: string[] | null, onEvent: (event: CatalogEvent) => void): Promise<void> {
  const channel = new Channel<CatalogEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("catalog_refresh", { connectionIds, onEvent: channel });
}

export const catalogSetState = (keys: string[], state: "available" | "ignored") =>
  invoke<void>("catalog_set_state", { keys, state });

export const catalogAdd = (keys: string[], folder?: string | null) =>
  invoke<{ added: ContextRef[]; failed: { key: string; message: string }[] }>("catalog_add", {
    keys,
    options: { folder: folder ?? null },
  });

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  sso: "IAM Identity Center",
  profile: "AWS profile",
  keys: "Access keys",
};

export const CONNECTION_STATUS: Record<CloudConnection["status"], { label: string; tone: "success" | "warning" | "destructive" | "muted" }> = {
  signedIn: { label: "Signed in", tone: "success" },
  expired: { label: "Sign-in expired", tone: "warning" },
  signedOut: { label: "Signed out", tone: "muted" },
  error: { label: "Error", tone: "destructive" },
};
