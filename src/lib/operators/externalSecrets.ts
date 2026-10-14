/*
 * External Secrets: sync state, store, target secret and refresh interval
 * in words; store providers by name; "Sync now" via the force-sync
 * annotation. Pure, unit tested.
 */
import {
  conditionOf,
  everyInWords,
  humanize,
  isFalse,
  isTrue,
  parseGoDuration,
  type OperatorState,
} from "./format";

export const FORCE_SYNC_ANNOTATION = "force-sync";

export function externalSecretState(secret: any): OperatorState {
  const ready = conditionOf(secret, "Ready");
  if (secret?.metadata?.deletionTimestamp) return { label: "Deleting", tone: "warning", busy: true };
  if (isTrue(ready)) return { label: "Synced", tone: "success", reason: ready!.reason, message: ready!.message };
  if (isFalse(ready)) {
    return { label: "Sync failed", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted", message: ready?.message };
}

/** "ClusterSecretStore aws-secrets" → { kind, name }. */
export function storeRef(secret: any): { kind: string; name: string } | null {
  const ref = secret?.spec?.secretStoreRef;
  if (!ref?.name) return null;
  return { kind: ref.kind ?? "SecretStore", name: ref.name };
}

/** The Secret it writes (defaults to the ExternalSecret's name). */
export const targetSecretName = (secret: any): string =>
  secret?.spec?.target?.name ?? secret?.metadata?.name ?? "";

/** "every hour", "never" (refreshInterval 0), the default otherwise. */
export function refreshInWords(secret: any): string {
  const interval = secret?.spec?.refreshInterval;
  // ESO's default refresh interval is one hour.
  const ms = interval === undefined ? 3_600_000 : parseGoDuration(interval);
  if (ms === null) return String(interval);
  return ms === 0 ? "Only once" : humanize(everyInWords(ms));
}

/** Annotation patch that makes ESO refresh right away. */
export const forceSyncPatch = (now = Date.now()) => ({
  metadata: { annotations: { [FORCE_SYNC_ANNOTATION]: String(Math.floor(now / 1000)) } },
});

const PROVIDERS: Record<string, string> = {
  vault: "HashiCorp Vault",
  gcpsm: "Google Secret Manager",
  azurekv: "Azure Key Vault",
  kubernetes: "Kubernetes",
  onepassword: "1Password",
  onepasswordSDK: "1Password",
  doppler: "Doppler",
  akeyless: "Akeyless",
  bitwardensecretsmanager: "Bitwarden",
  infisical: "Infisical",
  gitlab: "GitLab",
  ibm: "IBM Secrets Manager",
  yandexlockbox: "Yandex Lockbox",
  oracle: "Oracle Vault",
  alibaba: "Alibaba KMS",
  conjur: "CyberArk Conjur",
  webhook: "Webhook",
  fake: "Fake (testing)",
};

export interface Provider {
  /** "AWS Secrets Manager", "HashiCorp Vault". */
  name: string;
  /** "eu-west-1", "vault.acme.dev". */
  detail?: string;
}

const hostOf = (url: unknown) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return url ? String(url) : undefined;
  }
};

export function storeProvider(store: any): Provider | null {
  const provider = store?.spec?.provider ?? {};
  const key = Object.keys(provider)[0];
  if (!key) return null;
  const config = provider[key] ?? {};
  if (key === "aws") {
    return {
      name: config.service === "ParameterStore" ? "AWS Parameter Store" : "AWS Secrets Manager",
      detail: config.region,
    };
  }
  if (key === "vault") return { name: PROVIDERS.vault, detail: hostOf(config.server) };
  if (key === "gcpsm") return { name: PROVIDERS.gcpsm, detail: config.projectID };
  if (key === "azurekv") return { name: PROVIDERS.azurekv, detail: hostOf(config.vaultUrl) };
  return { name: PROVIDERS[key] ?? humanize(key) };
}

/** How a store signs in to its provider, in words. */
export function storeAuthInWords(store: any): string | undefined {
  const provider = store?.spec?.provider ?? {};
  const key = Object.keys(provider)[0];
  const auth = provider[key]?.auth ?? {};
  if (auth.jwt?.serviceAccountRef?.name) return `Service account ${auth.jwt.serviceAccountRef.name} (IRSA)`;
  if (auth.workloadIdentity) return "Workload identity";
  if (auth.kubernetes?.role) return `Kubernetes auth as ${auth.kubernetes.role}`;
  if (auth.appRole) return "AppRole";
  if (auth.tokenSecretRef?.name) return `Token from ${auth.tokenSecretRef.name}`;
  if (auth.secretRef) {
    const names = Object.values(auth.secretRef as Record<string, any>)
      .map((ref) => ref?.name)
      .filter(Boolean);
    return names.length ? `Keys from ${[...new Set(names)].join(", ")}` : "Keys from a secret";
  }
  if (provider[key]?.authType) return humanize(provider[key].authType);
  return undefined;
}

export const storeState = (store: any): OperatorState => {
  const ready = conditionOf(store, "Ready");
  if (isTrue(ready)) return { label: "Valid", tone: "success" };
  if (isFalse(ready)) {
    return { label: "Invalid", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted" };
};

export function pushSecretState(push: any): OperatorState {
  const ready = conditionOf(push, "Ready");
  if (isTrue(ready)) return { label: "Pushed", tone: "success" };
  if (isFalse(ready)) {
    return { label: "Push failed", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted" };
}
