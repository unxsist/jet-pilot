/*
 * The clouds JET Pilot connects to, as the add-cluster flow, the accounts
 * tab and the setup guide describe them: how they sign in, where a token
 * comes from, what an account reaches (projects, subscriptions, regions).
 * Pure (unit tested).
 */
import type { CloudConnection, CloudProvider, ConnectionKind } from "./cloud";

export interface TokenInfo {
  /** "API token", "Personal access token", "Secret key". */
  label: string;
  placeholder: string;
  /** Where to create one. */
  url: string;
  /** One line: what it needs. */
  hint: string;
  /** Scaleway: an optional project id. */
  project?: boolean;
}

export interface CloudProviderInfo {
  id: CloudProvider;
  /** "Google Cloud", "Amazon Web Services". */
  name: string;
  /** For tiles: "AWS", "Azure", "Akamai". */
  short: string;
  /** The Kubernetes product: "GKE". */
  product: string;
  /** One line for the chooser. */
  blurb: string;
  /** Ways to connect, the recommended one first. */
  methods: ConnectionKind[];
  cli?: { tool: "gcloud" | "az" | "doctl"; name: string };
  token?: TokenInfo;
  /** What an account reaches, when it can be narrowed down. */
  scopes?: { noun: string; plural: string };
  /** Clusters are listed per region or zone: offer to narrow them down. */
  regional?: { noun: "region" | "zone" };
}

export const CLOUD_PROVIDERS: readonly CloudProviderInfo[] = [
  {
    id: "aws",
    name: "Amazon Web Services",
    short: "AWS",
    product: "EKS",
    blurb: "Every account and region, with IAM Identity Center",
    methods: ["sso", "profile", "keys"],
    scopes: { noun: "account", plural: "accounts" },
    regional: { noun: "region" },
  },
  {
    id: "gcp",
    name: "Google Cloud",
    short: "Google Cloud",
    product: "GKE",
    blurb: "Every project you can see, through gcloud",
    methods: ["cli"],
    cli: { tool: "gcloud", name: "Google Cloud CLI" },
    scopes: { noun: "project", plural: "projects" },
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    short: "Azure",
    product: "AKS",
    blurb: "Every subscription you can see, through the Azure CLI",
    methods: ["cli"],
    cli: { tool: "az", name: "Azure CLI" },
    scopes: { noun: "subscription", plural: "subscriptions" },
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    short: "DigitalOcean",
    product: "DOKS",
    blurb: "With an API token, or your doctl sign-in",
    methods: ["token", "cli"],
    cli: { tool: "doctl", name: "doctl" },
    token: {
      label: "API token",
      placeholder: "dop_v1_…",
      url: "https://cloud.digitalocean.com/account/api/tokens",
      hint: "Read access to Kubernetes is enough (scoped tokens: kubernetes:read and kubernetes:access_cluster).",
    },
  },
  {
    id: "linode",
    name: "Akamai Cloud",
    short: "Akamai",
    product: "LKE",
    blurb: "Linode Kubernetes Engine, with a personal access token",
    methods: ["token"],
    token: {
      label: "Personal access token",
      placeholder: "Token",
      url: "https://cloud.linode.com/profile/tokens",
      hint: "Read-only access to Kubernetes is enough.",
    },
  },
  {
    id: "civo",
    name: "Civo",
    short: "Civo",
    product: "Kubernetes",
    blurb: "Every region, with an API key",
    methods: ["token"],
    token: {
      label: "API key",
      placeholder: "API key",
      url: "https://dashboard.civo.com/security",
      hint: "Find it under Settings › Profile › Security.",
    },
    regional: { noun: "region" },
  },
  {
    id: "scaleway",
    name: "Scaleway",
    short: "Scaleway",
    product: "Kapsule",
    blurb: "Paris, Amsterdam and Warsaw, with an API key",
    methods: ["token"],
    token: {
      label: "Secret key",
      placeholder: "Secret key (a UUID)",
      url: "https://console.scaleway.com/iam/api-keys",
      hint: "The secret key of an API key that can read Kubernetes.",
      project: true,
    },
    regional: { noun: "region" },
  },
  {
    id: "vultr",
    name: "Vultr",
    short: "Vultr",
    product: "VKE",
    blurb: "Vultr Kubernetes Engine, with an API key",
    methods: ["token"],
    token: {
      label: "API key",
      placeholder: "API key",
      url: "https://my.vultr.com/settings/#settingsapi",
      hint: "Allow access from your IP address in the API settings if you use an access list.",
    },
  },
  {
    id: "exoscale",
    name: "Exoscale",
    short: "Exoscale",
    product: "SKS",
    blurb: "Every zone, with an API key and secret",
    methods: ["apiKey"],
    regional: { noun: "zone" },
  },
];

export const providerInfo = (id: CloudProvider): CloudProviderInfo => CLOUD_PROVIDERS.find((p) => p.id === id)!;

/** "Google Cloud CLI", "API token", "IAM Identity Center". */
export function connectionKindLabel(connection: Pick<CloudConnection, "provider" | "kind">): string {
  const info = providerInfo(connection.provider);
  if (connection.kind === "cli") return info.cli?.name ?? "Command-line sign-in";
  if (connection.kind === "token") return info.token?.label ?? "API token";
  if (connection.kind === "apiKey") return "API key";
  return { sso: "IAM Identity Center", profile: "AWS profile", keys: "Access keys" }[connection.kind];
}

/** Whether a pasted token is worth sending (the provider checks it for real). */
export function tokenLooksValid(provider: CloudProvider, token: string): boolean {
  const value = token.trim();
  if (/\s/.test(value)) return false;
  if (provider === "scaleway") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return value.length >= 20;
}

/** Exoscale groups as typed ("system:masters, ops") → a clean list. */
export const parseGroups = (text: string) => [...new Set(text.split(/[\s,]+/).map((g) => g.trim()).filter(Boolean))];

/** What the account menu offers to narrow down: "Projects…", "Accounts and regions…", "Zones…". */
export function narrowLabel(connection: Pick<CloudConnection, "provider" | "kind">): string | null {
  const info = providerInfo(connection.provider);
  if (connection.provider === "aws") return connection.kind === "sso" ? "Accounts and regions…" : "Regions…";
  if (info.scopes) return `${info.scopes.plural[0]!.toUpperCase()}${info.scopes.plural.slice(1)}…`;
  if (info.regional) return info.regional.noun === "zone" ? "Zones…" : "Regions…";
  return null;
}
