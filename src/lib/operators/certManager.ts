/*
 * cert-manager: certificate state and expiry in words, issuers, and the
 * ACME issuance chain (request → order → challenges), where most failures
 * hide. Pure, unit tested.
 */
import {
  conditionOf,
  isFalse,
  isTrue,
  relativeInWords,
  spanInWords,
  toTime,
  type OperatorState,
} from "./format";
import type { StatusTone } from "@/components/ui/status/tones";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Expiry {
  /** "Expires in 23 days", "Expired 2 days ago". */
  label: string;
  /** For table cells: "in 23 days", "2 days ago". */
  short: string;
  tone: StatusTone;
  at: number;
  expired: boolean;
}

/**
 * When the certificate expires, with a tone near expiry:
 * - expired, or less than a week left of a long-lived certificate (or
 *   under 10% of a short-lived one's lifetime): destructive;
 * - renewal overdue (an hour past `renewalTime`), or under 30 days left of a
 *   long-lived certificate whose renewal time is unknown: warning.
 */
export function certificateExpiry(cert: any, now = Date.now()): Expiry | null {
  const at = toTime(cert?.status?.notAfter);
  if (at === null) return null;
  const remaining = at - now;
  const notBefore = toTime(cert?.status?.notBefore);
  const lifetime = notBefore !== null ? at - notBefore : null;
  const renewal = toTime(cert?.status?.renewalTime);

  if (remaining <= 0) {
    const ago = `${spanInWords(remaining)} ago`;
    return { label: `Expired ${ago}`, short: ago, tone: "destructive", at, expired: true };
  }

  const longLived = lifetime === null || lifetime > 14 * DAY;
  let tone: StatusTone = "muted";
  if ((longLived && remaining < 7 * DAY) || (lifetime !== null && remaining < lifetime * 0.1)) {
    tone = "destructive";
  } else if (renewal !== null ? now > renewal + HOUR : longLived && remaining < 30 * DAY) {
    tone = "warning";
  }
  const short = relativeInWords(at, now);
  return { label: `Expires ${short}`, short, tone, at, expired: false };
}

/** "renews in 2 days", "renewal was due 7 days ago". */
export function renewalInWords(cert: any, now = Date.now()): string | null {
  const at = toTime(cert?.status?.renewalTime);
  if (at === null) return null;
  return at > now ? `renews ${relativeInWords(at, now)}` : `renewal was due ${relativeInWords(at, now)}`;
}

export function certificateState(cert: any, now = Date.now()): OperatorState {
  const ready = conditionOf(cert, "Ready");
  const issuing = conditionOf(cert, "Issuing");
  const expiry = certificateExpiry(cert, now);

  if (isTrue(issuing)) {
    return {
      label: "Issuing",
      tone: "info",
      busy: true,
      reason: issuing!.reason,
      message: issuing!.message,
    };
  }
  const failed = isFalse(issuing) && issuing!.reason === "Failed";
  // Expired outranks a failed renewal; the failure says why.
  if (expiry?.expired) {
    const why = failed ? issuing! : ready;
    return { label: "Expired", tone: "destructive", reason: why?.reason, message: why?.message };
  }
  if (failed) {
    return {
      label: "Issuance failed",
      tone: "destructive",
      reason: issuing!.reason,
      message: issuing!.message,
    };
  }
  if (isTrue(ready)) return { label: "Ready", tone: "success" };
  if (isFalse(ready)) {
    return { label: "Not ready", tone: "warning", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted" };
}

/** Renewing makes sense unless an issuance is already running. */
export const canRenew = (cert: any) => !isTrue(conditionOf(cert, "Issuing"));

/**
 * A status patch that asks cert-manager to issue the certificate again: the
 * Issuing condition set to True, like `cmctl renew` does. Merge patches
 * replace lists, so it carries the other conditions too.
 */
export function renewPatch(cert: any, now = Date.now()) {
  const others = (cert?.status?.conditions ?? []).filter((c: any) => c?.type !== "Issuing");
  return {
    status: {
      conditions: [
        ...others,
        {
          type: "Issuing",
          status: "True",
          reason: "ManuallyTriggered",
          message: "Certificate re-issuance manually triggered",
          lastTransitionTime: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
          ...(cert?.metadata?.generation !== undefined
            ? { observedGeneration: cert.metadata.generation }
            : {}),
        },
      ],
    },
  };
}

/** "ClusterIssuer letsencrypt-prod". */
export function issuerRefInWords(ref: any): string {
  if (!ref?.name) return "";
  const kind = ref.kind || "Issuer";
  const external = ref.group && ref.group !== "cert-manager.io";
  return external ? `${ref.name} (${kind}, ${ref.group})` : `${kind} ${ref.name}`;
}

/** DNS names, then IP addresses, URIs and e-mail addresses of a certificate. */
export const certificateNames = (cert: any): string[] => [
  ...(cert?.spec?.dnsNames ?? []),
  ...(cert?.spec?.ipAddresses ?? []),
  ...(cert?.spec?.uris ?? []),
  ...(cert?.spec?.emailAddresses ?? []),
  ...(cert?.spec?.commonName && !(cert?.spec?.dnsNames ?? []).includes(cert.spec.commonName)
    ? [cert.spec.commonName]
    : []),
];

/* ----------------------------------------------------------- issuers -- */

export interface IssuerType {
  /** "ACME", "CA", "Vault", "Self-signed", "Venafi". */
  type: string;
  /** The ACME directory / Vault server in words, e.g. "Let's Encrypt". */
  detail?: string;
  server?: string;
  email?: string;
}

const ACME_SERVERS: [RegExp, string][] = [
  [/acme-staging-v02\.api\.letsencrypt\.org/, "Let's Encrypt staging"],
  [/acme-v02\.api\.letsencrypt\.org/, "Let's Encrypt"],
  [/acme\.zerossl\.com/, "ZeroSSL"],
  [/api\.pki\.goog/, "Google Trust Services"],
  [/api\.buypass\.com/, "Buypass"],
];

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function issuerType(issuer: any): IssuerType {
  const spec = issuer?.spec ?? {};
  if (spec.acme) {
    const server = String(spec.acme.server ?? "");
    const known = ACME_SERVERS.find(([pattern]) => pattern.test(server))?.[1];
    return { type: "ACME", detail: known ?? hostOf(server), server, email: spec.acme.email };
  }
  if (spec.ca) return { type: "CA", detail: spec.ca.secretName ? `from ${spec.ca.secretName}` : undefined };
  if (spec.vault) {
    const server = String(spec.vault.server ?? "");
    return { type: "Vault", detail: hostOf(server), server };
  }
  if (spec.selfSigned) return { type: "Self-signed" };
  if (spec.venafi) return { type: "Venafi", detail: spec.venafi.cloud ? "Cloud" : "TPP" };
  return { type: "Other" };
}

/* ------------------------------------------------- the issuance chain -- */

export function certificateRequestState(request: any): OperatorState {
  const ready = conditionOf(request, "Ready");
  const denied = conditionOf(request, "Denied");
  const invalid = conditionOf(request, "InvalidRequest");
  if (isTrue(denied)) return { label: "Denied", tone: "destructive", reason: denied!.reason, message: denied!.message };
  if (isTrue(invalid)) return { label: "Invalid", tone: "destructive", reason: invalid!.reason, message: invalid!.message };
  if (isTrue(ready)) return { label: "Issued", tone: "success" };
  if (isFalse(ready) && ready!.reason === "Failed") {
    return { label: "Failed", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  if (!isTrue(conditionOf(request, "Approved"))) {
    return { label: "Waiting for approval", tone: "info", busy: true, message: ready?.message };
  }
  return { label: "Pending", tone: "info", busy: true, reason: ready?.reason, message: ready?.message };
}

const ACME_STATES: Record<string, OperatorState> = {
  valid: { label: "Valid", tone: "success" },
  ready: { label: "Finalizing", tone: "info", busy: true },
  pending: { label: "Pending", tone: "info", busy: true },
  processing: { label: "Processing", tone: "info", busy: true },
  invalid: { label: "Invalid", tone: "destructive" },
  errored: { label: "Errored", tone: "destructive" },
  expired: { label: "Expired", tone: "muted" },
};

export function orderState(order: any): OperatorState {
  const state = ACME_STATES[String(order?.status?.state ?? "").toLowerCase()];
  const reason = order?.status?.reason || undefined;
  return state ? { ...state, message: reason } : { label: "Pending", tone: "muted", message: reason };
}

/* Challenges pending this long are stuck rather than in progress. */
const STUCK_AFTER = 10 * 60_000;

export function challengeState(challenge: any, now = Date.now()): OperatorState {
  const state = String(challenge?.status?.state ?? "").toLowerCase();
  const message = challenge?.status?.reason || undefined;
  const base = ACME_STATES[state] ?? { label: "Pending", tone: "info", busy: true };
  if (base.label === "Pending") {
    const created = toTime(challenge?.metadata?.creationTimestamp);
    if (created !== null && now - created > STUCK_AFTER) {
      return { label: "Pending", tone: "warning", message };
    }
  }
  return { ...base, message };
}

/** "HTTP-01" / "DNS-01". */
export const challengeType = (challenge: any): string =>
  String(challenge?.spec?.type ?? "").toUpperCase() || (challenge?.spec?.solver?.dns01 ? "DNS-01" : "HTTP-01");

const DNS_PROVIDERS: Record<string, string> = {
  route53: "Route 53",
  cloudflare: "Cloudflare",
  cloudDNS: "Google Cloud DNS",
  azureDNS: "Azure DNS",
  digitalocean: "DigitalOcean",
  akamai: "Akamai",
  rfc2136: "RFC 2136",
  acmeDNS: "ACME-DNS",
  webhook: "Webhook",
};

/** How an ACME solver answers: "Ingress (nginx)", "Route 53", "Cloudflare". */
export function solverProvider(solver: any): string {
  if (solver?.http01?.ingress) {
    const ingress = solver.http01.ingress;
    const cls = ingress.ingressClassName ?? ingress.class;
    return cls ? `Ingress (${cls})` : "Ingress";
  }
  if (solver?.http01?.gatewayHTTPRoute) return "Gateway API route";
  const key = Object.keys(solver?.dns01 ?? {}).find((k) => k in DNS_PROVIDERS);
  return key ? DNS_PROVIDERS[key] : "";
}

/** An issuer's solver: "DNS-01 via Route 53 for acme.dev". */
export function solverInWords(solver: any): string {
  const type = solver?.dns01 ? "DNS-01" : "HTTP-01";
  const provider = solverProvider(solver);
  const selector = solver?.selector ?? {};
  const scope = [...(selector.dnsZones ?? []), ...(selector.dnsNames ?? [])];
  return `${type}${provider ? ` via ${provider}` : ""}${scope.length ? ` for ${scope.join(", ")}` : ""}`;
}

export const challengeSolver = (challenge: any): string => solverProvider(challenge?.spec?.solver);

/*
 * The usual ACME failures in plain words. The CA's message stays visible
 * next to it; this is the one line people read first.
 */
const CHALLENGE_HINTS: [RegExp, (match: RegExpMatchArray, type: string) => string][] = [
  [/wrong status code '(\d+)'/i, (m) => `The challenge URL answers ${m[1]} instead of 200`],
  [/Invalid response from \S+: (\d{3})\b/i, (m) => `The CA got a ${m[1]} from the challenge URL`],
  [/no such host|NXDOMAIN/i, () => "The domain doesn't resolve"],
  [/not yet propagated|propagation check failed|waiting for dns-01/i, () => "The DNS record isn't visible yet"],
  [/rate ?limit|too many (certificates|failed authorizations)/i, () => "The CA's rate limit was hit"],
  [/connection refused/i, () => "The domain refused the connection"],
  [/timeout|timed out|deadline exceeded/i, () => "Reaching the domain timed out"],
  [/CAA record/i, () => "A CAA record doesn't allow this CA"],
  [/unauthorized|Invalid response/i, (_, type) =>
    type === "DNS-01" ? "The CA couldn't find the DNS record" : "The CA couldn't fetch the challenge"],
  [/waiting for http-01/i, () => "Waiting until the challenge URL answers"],
];

export function challengeHint(challenge: any): string | null {
  const reason = String(challenge?.status?.reason ?? "");
  if (!reason) return null;
  const type = challengeType(challenge);
  for (const [pattern, describe] of CHALLENGE_HINTS) {
    const match = reason.match(pattern);
    if (match) return describe(match, type);
  }
  return null;
}

const ownedBy = (object: any, uid: string | undefined) =>
  !!uid && (object?.metadata?.ownerReferences ?? []).some((ref: any) => ref?.uid === uid);

const newestFirst = (a: any, b: any) =>
  (toTime(b?.metadata?.creationTimestamp) ?? 0) - (toTime(a?.metadata?.creationTimestamp) ?? 0);

export interface IssuanceChain {
  request?: any;
  order?: any;
  challenges: any[];
}

/**
 * The latest issuance of a certificate: its newest CertificateRequest, that
 * request's newest Order and the Order's Challenges (from lists of the
 * certificate's namespace).
 */
export function issuanceChain(
  cert: any,
  requests: any[],
  orders: any[],
  challenges: any[]
): IssuanceChain {
  const name = cert?.metadata?.name;
  const request = requests
    .filter(
      (r) =>
        ownedBy(r, cert?.metadata?.uid) ||
        r?.metadata?.annotations?.["cert-manager.io/certificate-name"] === name
    )
    .sort(newestFirst)[0];
  const order = request
    ? orders.filter((o) => ownedBy(o, request.metadata?.uid)).sort(newestFirst)[0]
    : undefined;
  return {
    request,
    order,
    challenges: order ? challenges.filter((c) => ownedBy(c, order.metadata?.uid)) : [],
  };
}
