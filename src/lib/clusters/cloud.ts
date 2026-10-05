/*
 * Cloud accounts and the live cluster catalog (src-tauri: connections,
 * catalog, providers): AWS (IAM Identity Center, profiles, access keys),
 * Google Cloud and Azure through their CLIs, DigitalOcean (API token or
 * doctl), Akamai/Linode, Civo, Scaleway and Vultr (API tokens) and
 * Exoscale (API key). The catalog lists every cluster a connected account
 * can see; adding one writes it into JET Pilot's kubeconfig.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ContextRef } from "@/lib/contextKey";
import type { LoginEvent } from "@/lib/auth/types";

export type CloudProvider =
  | "aws"
  | "gcp"
  | "azure"
  | "digitalocean"
  | "linode"
  | "civo"
  | "scaleway"
  | "vultr"
  | "exoscale";
export type ConnectionKind = "sso" | "profile" | "keys" | "cli" | "token" | "apiKey";
export type CliProvider = "gcp" | "azure" | "digitalocean";
export type TokenProvider = "digitalocean" | "linode" | "civo" | "scaleway" | "vultr";

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
  /** gcloud account / az user / doctl context (null: the CLI's current one). */
  cliAccount?: string | null;
  /** Scaleway project. */
  projectId?: string | null;
  /** Exoscale: who the minted kubeconfig certificates are for. */
  exoscale?: { user: string; groups: string[] } | null;
  /** Empty: every enabled region. */
  regions: string[];
  /** AWS accounts + roles, Google Cloud projects, Azure subscriptions (empty: all of them). */
  targets: ConnectionTarget[];
  status: "signedIn" | "expired" | "signedOut" | "error";
  expiresAt?: number | null;
  message?: string | null;
  createdAt: number;
}

export type ConnectionSpec =
  | { kind: "sso"; label?: string; startUrl: string; region: string }
  | { kind: "profile"; label?: string; profile: string }
  | { kind: "keys"; label?: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }
  | { kind: "cli"; provider: CliProvider; label?: string; cliAccount?: string }
  | { kind: "token"; provider: TokenProvider; label?: string; token: string; projectId?: string }
  | { kind: "apiKey"; provider: "exoscale"; label?: string; key: string; secret: string; user?: string; groups?: string[] };

export const listConnections = () => invoke<CloudConnection[]>("connections_list");
export const createConnection = (spec: ConnectionSpec) => invoke<CloudConnection>("connection_create", { spec });
export const updateConnection = (
  id: string,
  patch: Partial<Pick<CloudConnection, "label" | "regions" | "targets">> & { exoscale?: { user: string; groups: string[] } }
) =>
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

/* ------------------------------------------------- CLIs, scopes, regions -- */

export interface CloudCliStatus {
  tool: "gcloud" | "az" | "doctl";
  installed: boolean;
  version?: string | null;
  path?: string | null;
  signedIn: boolean;
  account?: string | null;
  accounts: string[];
  /** The plugin added clusters sign in with (GKE: gke-gcloud-auth-plugin, AKS: kubelogin). */
  authPlugin?: { name: "gke-gcloud-auth-plugin" | "kubelogin"; installed: boolean; managed: boolean; path?: string | null } | null;
  installUrl: string;
  message?: string | null;
}
/** Whether gcloud / az / doctl is installed and signed in (never prompts). */
export const cloudCliStatus = (provider: CliProvider) => invoke<CloudCliStatus>("cloud_cli_status", { provider });
/** Signs in with gcloud (browser) or az (device code), streaming LoginEvents. */
export const cloudCliSignIn = (provider: CliProvider, channel: Channel<LoginEvent>) =>
  invoke<string>("cloud_cli_sign_in", { provider, onEvent: channel });

/** Google Cloud projects or Azure subscriptions a CLI connection reaches. */
export interface ConnectionScope {
  id: string;
  name: string;
  detail?: string | null;
}
export const connectionScopes = (connectionId: string) => invoke<ConnectionScope[]>("connection_scopes", { connectionId });
/** Regions (or zones) a provider has clusters in. */
export const providerRegions = (provider: CloudProvider) => invoke<string[]>("provider_regions", { provider });

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

export interface CatalogAddResult {
  added: ContextRef[];
  failed: { key: string; message: string }[];
  /** Added, but something needs attention (e.g. a missing sign-in plugin). */
  warnings?: { key: string; message: string }[];
}
export const catalogAdd = (keys: string[], folder?: string | null) =>
  invoke<CatalogAddResult>("catalog_add", {
    keys,
    options: { folder: folder ?? null },
  });

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  sso: "IAM Identity Center",
  profile: "AWS profile",
  keys: "Access keys",
  cli: "Command-line sign-in",
  token: "API token",
  apiKey: "API key",
};

export const CONNECTION_STATUS: Record<CloudConnection["status"], { label: string; tone: "success" | "warning" | "destructive" | "muted" }> = {
  signedIn: { label: "Signed in", tone: "success" },
  expired: { label: "Sign-in expired", tone: "warning" },
  signedOut: { label: "Signed out", tone: "muted" },
  error: { label: "Error", tone: "destructive" },
};
