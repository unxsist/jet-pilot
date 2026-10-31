/*
 * Certificates about to expire, at 14, 7 and 3 days: cert-manager
 * Certificates that aren't being renewed, TLS Secrets (parsed in the
 * backend, see src-tauri/src/certificates.rs) and the client certificate
 * the kubeconfig signs in with. Pure.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import { renewalInWords } from "@/lib/operators/certManager";
import { toTime } from "@/lib/operators/format";
import { DAY_MS, relativeDays } from "./days";
import type { RiskItem } from "./rules";
import type { Scope } from "./workloads";

/** Certificates expiring within this many days are listed. */
export const EXPIRY_DAYS = [14, 7, 3] as const;
const WINDOW_MS = EXPIRY_DAYS[0] * DAY_MS;

/** A TLS Secret's certificate, as `tls_certificates` describes it. */
export interface TlsCertificate {
  name: string;
  namespace: string;
  notAfter: number | null;
  notBefore: number | null;
  subject: string | null;
  dnsNames: string[];
  /** The cert-manager Certificate that keeps it renewed. */
  certificate: string | null;
  error: string | null;
}

/** Expired or 3 days left: destructive; 7 days: warning; 14 days: listed quietly. */
export function expiryTone(at: number, now: number): StatusTone {
  const left = at - now;
  if (left <= EXPIRY_DAYS[2] * DAY_MS) return "destructive";
  if (left <= EXPIRY_DAYS[1] * DAY_MS) return "warning";
  return "muted";
}

export function expiryWords(at: number, now: number): string {
  return at <= now ? `Expired ${relativeDays(at, now)}` : `Expires ${relativeDays(at, now)}`;
}

/**
 * A cert-manager Certificate needs attention when it expired, or has under
 * 14 days left while its renewal is overdue (or unknown). Short-lived
 * certificates renewing on schedule stay quiet.
 */
function certificateNeedsRenewal(cert: any, now: number): boolean {
  const notAfter = toTime(cert?.status?.notAfter);
  if (notAfter === null) return false;
  if (notAfter <= now) return true;
  if (notAfter - now > WINDOW_MS) return false;
  const renewal = toTime(cert?.status?.renewalTime);
  return renewal === null || renewal < now;
}

export interface ExpiryInput extends Scope {
  now: number;
  /** cert-manager Certificates. */
  certificates: any[];
  tls: TlsCertificate[];
}

export function expiryRisks(input: ExpiryInput): RiskItem[] {
  const items: RiskItem[] = [];
  const { now } = input;
  const managed = new Set<string>();
  for (const cert of input.certificates) {
    const ns = cert?.metadata?.namespace ?? "";
    managed.add(`${ns}/${cert?.metadata?.name}`);
    if (!certificateNeedsRenewal(cert, now)) continue;
    const at = toTime(cert.status.notAfter)!;
    const renewal = at > now ? renewalInWords(cert, now) : null;
    items.push({
      rule: "certificate-expiry",
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: "Certificate", name: cert.metadata.name, namespace: ns, apiVersion: cert.apiVersion ?? "cert-manager.io/v1" },
      detail: [expiryWords(at, now), renewal].filter(Boolean).join(" · "),
      tone: expiryTone(at, now),
      order: at,
      action: "renew",
      raw: cert,
    });
  }
  for (const tls of input.tls) {
    if (tls.notAfter === null || tls.notAfter - now > WINDOW_MS) continue;
    // cert-manager's own Certificate already speaks for the Secret it issues.
    if (tls.certificate && managed.has(`${tls.namespace}/${tls.certificate}`)) continue;
    const name = tls.subject ?? tls.dnsNames[0];
    items.push({
      rule: "certificate-expiry",
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: "Secret", name: tls.name, namespace: tls.namespace, apiVersion: "v1" },
      detail: [expiryWords(tls.notAfter, now), name].filter(Boolean).join(" · "),
      tone: expiryTone(tls.notAfter, now),
      order: tls.notAfter,
    });
  }
  return items;
}

/** The kubeconfig's client certificate (`auth_credential_status`), when it expires within 14 days. */
export function clientCertificateRisk(
  input: Scope & { now: number; credential: { kind?: string; expiresAt?: number | null } | null }
): RiskItem | null {
  const credential = input.credential;
  if (credential?.kind !== "clientCert" || !credential.expiresAt) return null;
  const at = credential.expiresAt;
  if (at - input.now > WINDOW_MS) return null;
  return {
    rule: "client-certificate",
    context: input.context,
    kubeConfig: input.kubeConfig,
    object: { kind: "Context", name: input.context },
    detail: expiryWords(at, input.now),
    tone: expiryTone(at, input.now),
    order: at,
  };
}
