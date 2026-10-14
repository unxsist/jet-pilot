import { describe, expect, test } from "vitest";
import {
  everyInWords,
  goDurationInWords,
  humanize,
  parseGoDuration,
  parseSimpleCron,
  relativeInWords,
  selectorInWords,
  spanInWords,
} from "@/lib/operators/format";
import {
  canRenew,
  certificateExpiry,
  certificateRequestState,
  certificateState,
  challengeHint,
  challengeState,
  issuanceChain,
  issuerType,
  renewPatch,
  solverInWords,
} from "@/lib/operators/certManager";
import {
  gatewayListeners,
  gatewayState,
  matchInWords,
  routeParents,
  routeRules,
  routeState,
  routesOfGateway,
} from "@/lib/operators/gatewayApi";
import {
  capacityType,
  disruptionInWords,
  nodeClaimState,
  nodePoolUsage,
  requirementsInWords,
} from "@/lib/operators/karpenter";
import {
  authSourcesInWords,
  isPaused,
  pausePatch,
  promMetricName,
  replicaRange,
  scaledObjectState,
  triggerInWords,
} from "@/lib/operators/keda";
import {
  externalSecretState,
  forceSyncPatch,
  refreshInWords,
  storeProvider,
} from "@/lib/operators/externalSecrets";
import { monitorTargetInWords, rulesInWords } from "@/lib/operators/prometheus";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const cond = (type: string, status: string, reason?: string, message?: string) => ({ type, status, reason, message });

describe("words", () => {
  test("spans and relative times", () => {
    expect(spanInWords(23 * DAY + 5000)).toBe("23 days");
    expect(spanInWords(36 * 3_600_000)).toBe("36 hours");
    expect(spanInWords(1 * 3_600_000)).toBe("1 hour");
    expect(spanInWords(12 * 60_000)).toBe("12 minutes");
    expect(spanInWords(20_000)).toBe("a few seconds");
    expect(spanInWords(800 * DAY)).toBe("2 years");
    expect(relativeInWords(NOW + 3 * DAY, NOW)).toBe("in 3 days");
    expect(relativeInWords(NOW - 2 * DAY, NOW)).toBe("2 days ago");
  });

  test("Go durations", () => {
    expect(parseGoDuration("1h30m")).toBe(90 * 60_000);
    expect(parseGoDuration("0")).toBe(0);
    expect(parseGoDuration("soon")).toBeNull();
    expect(goDurationInWords("720h")).toBe("30 days");
    expect(goDurationInWords("1m")).toBe("1 minute");
    expect(goDurationInWords("90s")).toBe("90 seconds");
    expect(everyInWords(3_600_000)).toBe("every hour");
    expect(everyInWords(15 * 60_000)).toBe("every 15 minutes");
    expect(everyInWords(30_000)).toBe("every 30 seconds");
  });

  test("cron, selectors, machine words", () => {
    expect(parseSimpleCron("0 9 * * mon-fri")).toEqual({ time: "09:00", days: "Mon–Fri" });
    expect(parseSimpleCron("30 22 * * *")).toEqual({ time: "22:30", days: null });
    expect(parseSimpleCron("0 8 * * 1-5")).toEqual({ time: "08:00", days: "Mon–Fri" });
    expect(parseSimpleCron("*/5 * * * *")).toBeNull();
    expect(selectorInWords({ matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["a", "b"] }] })).toBe(
      "app=web, tier in (a, b)"
    );
    expect(selectorInWords({})).toBe("everything");
    expect(humanize("NoMatchingListenerHostname")).toBe("No matching listener hostname");
    expect(humanize("SecretSyncedError")).toBe("Secret synced error");
  });
});

describe("cert-manager", () => {
  const cert = (o: { notAfter: number; notBefore?: number; renewal?: number; conditions?: any[] }) => ({
    apiVersion: "cert-manager.io/v1",
    metadata: { name: "web", uid: "c1", generation: 4 },
    status: {
      notAfter: at(o.notAfter),
      ...(o.notBefore !== undefined ? { notBefore: at(o.notBefore) } : {}),
      ...(o.renewal !== undefined ? { renewalTime: at(o.renewal) } : {}),
      conditions: o.conditions ?? [cond("Ready", "True")],
    },
  });

  test("expiry tones", () => {
    // A healthy 90-day certificate: quiet.
    expect(certificateExpiry(cert({ notAfter: 53 * DAY, notBefore: -37 * DAY, renewal: 23 * DAY }), NOW)).toMatchObject({
      label: "Expires in 53 days",
      short: "in 53 days",
      tone: "muted",
    });
    // Renewal overdue: warning.
    expect(certificateExpiry(cert({ notAfter: 23 * DAY, notBefore: -67 * DAY, renewal: -7 * DAY }), NOW)?.tone).toBe("warning");
    // Unknown renewal time, under 30 days left of a long-lived certificate.
    expect(certificateExpiry(cert({ notAfter: 25 * DAY }), NOW)?.tone).toBe("warning");
    // Less than a week left.
    expect(certificateExpiry(cert({ notAfter: 5 * DAY, notBefore: -85 * DAY, renewal: 25 * DAY }), NOW)?.tone).toBe("destructive");
    // Expired.
    expect(certificateExpiry(cert({ notAfter: -2 * DAY }), NOW)).toMatchObject({
      label: "Expired 2 days ago",
      tone: "destructive",
      expired: true,
    });
    // A short-lived (24h) certificate renews every few hours: quiet with 16 hours left.
    expect(
      certificateExpiry(cert({ notAfter: 16 * 3_600_000, notBefore: -8 * 3_600_000, renewal: 8 * 3_600_000 }), NOW)?.tone
    ).toBe("muted");
    expect(certificateExpiry({ status: {} }, NOW)).toBeNull();
  });

  test("states", () => {
    expect(certificateState(cert({ notAfter: 50 * DAY }), NOW).label).toBe("Ready");
    expect(
      certificateState(cert({ notAfter: 50 * DAY, conditions: [cond("Ready", "False", "DoesNotExist"), cond("Issuing", "True", "DoesNotExist", "Issuing certificate as Secret does not exist")] }), NOW)
    ).toMatchObject({ label: "Issuing", tone: "info", busy: true });
    expect(
      certificateState(cert({ notAfter: 22 * DAY, conditions: [cond("Ready", "True"), cond("Issuing", "False", "Failed", "order is invalid")] }), NOW)
    ).toMatchObject({ label: "Issuance failed", tone: "destructive", message: "order is invalid" });
    expect(certificateState(cert({ notAfter: -DAY, conditions: [cond("Ready", "False", "Expired")] }), NOW)).toMatchObject({
      label: "Expired",
      tone: "destructive",
    });
    expect(
      certificateState(cert({ notAfter: -DAY, conditions: [cond("Ready", "False", "Expired"), cond("Issuing", "False", "Failed", "order is invalid")] }), NOW)
    ).toMatchObject({ label: "Expired", message: "order is invalid" });
    expect(certificateState(cert({ notAfter: 50 * DAY, conditions: [cond("Ready", "False", "Pending", "waiting")] }), NOW)).toMatchObject({
      label: "Not ready",
      tone: "warning",
    });
  });

  test("renew sets the Issuing condition like cmctl, keeping the others", () => {
    const c = cert({ notAfter: 10 * DAY, conditions: [cond("Ready", "True"), cond("Issuing", "False", "Failed")] });
    expect(canRenew(c)).toBe(true);
    const patch = renewPatch(c, NOW);
    expect(patch.status.conditions).toEqual([
      cond("Ready", "True"),
      {
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        message: "Certificate re-issuance manually triggered",
        lastTransitionTime: "2026-10-15T12:00:00Z",
        observedGeneration: 4,
      },
    ]);
    expect(canRenew({ status: { conditions: [cond("Issuing", "True")] } })).toBe(false);
  });

  test("issuers", () => {
    expect(issuerType({ spec: { acme: { server: "https://acme-v02.api.letsencrypt.org/directory", email: "a@b.c" } } })).toMatchObject({
      type: "ACME",
      detail: "Let's Encrypt",
      email: "a@b.c",
    });
    expect(issuerType({ spec: { acme: { server: "https://acme-staging-v02.api.letsencrypt.org/directory" } } }).detail).toBe(
      "Let's Encrypt staging"
    );
    expect(issuerType({ spec: { acme: { server: "https://acme.example.org/dir" } } }).detail).toBe("acme.example.org");
    expect(issuerType({ spec: { ca: { secretName: "root" } } })).toEqual({ type: "CA", detail: "from root" });
    expect(issuerType({ spec: { vault: { server: "https://vault.acme.dev" } } }).detail).toBe("vault.acme.dev");
    expect(issuerType({ spec: { selfSigned: {} } }).type).toBe("Self-signed");
    expect(solverInWords({ dns01: { route53: {} }, selector: { dnsZones: ["acme.dev"] } })).toBe("DNS-01 via Route 53 for acme.dev");
    expect(solverInWords({ http01: { ingress: { ingressClassName: "nginx" } } })).toBe("HTTP-01 via Ingress (nginx)");
  });

  test("requests and challenges", () => {
    expect(certificateRequestState({ status: { conditions: [cond("Approved", "True"), cond("Ready", "True", "Issued")] } }).label).toBe("Issued");
    expect(certificateRequestState({ status: { conditions: [cond("Denied", "True", "Policy")] } }).tone).toBe("destructive");
    expect(certificateRequestState({ status: { conditions: [] } }).label).toBe("Waiting for approval");

    const challenge = (state: string, reason: string, type = "HTTP-01", age = 60_000) => ({
      metadata: { creationTimestamp: at(-age) },
      spec: { type },
      status: { state, reason },
    });
    expect(challengeState(challenge("pending", ""), NOW)).toMatchObject({ label: "Pending", tone: "info", busy: true });
    expect(challengeState(challenge("pending", "", "HTTP-01", 40 * 60_000), NOW).tone).toBe("warning");
    expect(challengeState(challenge("invalid", "nope"), NOW)).toMatchObject({ label: "Invalid", tone: "destructive", message: "nope" });
    expect(challengeState(challenge("valid", ""), NOW).tone).toBe("success");

    expect(challengeHint(challenge("pending", "Waiting for HTTP-01 challenge propagation: wrong status code '404', expected '200'"))).toBe(
      "The challenge URL answers 404 instead of 200"
    );
    expect(
      challengeHint(challenge("invalid", "acme: authorization error for x: 403 urn:ietf:params:acme:error:unauthorized: 1.2.3.4: Invalid response from http://x/.well-known/acme-challenge/t: 404"))
    ).toBe("The CA got a 404 from the challenge URL");
    expect(challengeHint(challenge("pending", 'Waiting for DNS-01 challenge propagation: DNS record for "x" not yet propagated', "DNS-01"))).toBe(
      "The DNS record isn't visible yet"
    );
    expect(challengeHint(challenge("errored", "urn:ietf:params:acme:error:rateLimited: too many certificates already issued"))).toBe(
      "The CA's rate limit was hit"
    );
    expect(challengeHint(challenge("invalid", "acme: unauthorized: incorrect TXT record", "DNS-01"))).toBe(
      "The CA couldn't find the DNS record"
    );
    expect(challengeHint(challenge("pending", ""))).toBeNull();
  });

  test("the issuance chain follows owner references", () => {
    const c = { metadata: { name: "web", uid: "c1" } };
    const old = { metadata: { name: "web-1", uid: "r1", creationTimestamp: at(-9 * DAY), ownerReferences: [{ uid: "c1" }] } };
    const latest = { metadata: { name: "web-2", uid: "r2", creationTimestamp: at(-DAY), ownerReferences: [{ uid: "c1" }] } };
    const other = { metadata: { name: "api-1", uid: "r3", creationTimestamp: at(0), annotations: { "cert-manager.io/certificate-name": "api" } } };
    const order = { metadata: { name: "web-2-1", uid: "o1", creationTimestamp: at(-DAY), ownerReferences: [{ uid: "r2" }] } };
    const ch1 = { metadata: { name: "web-2-1-1", ownerReferences: [{ uid: "o1" }] } };
    const ch2 = { metadata: { name: "x", ownerReferences: [{ uid: "o9" }] } };
    expect(issuanceChain(c, [old, other, latest], [order], [ch1, ch2])).toEqual({ request: latest, order, challenges: [ch1] });
    expect(issuanceChain(c, [], [order], [ch1])).toEqual({ request: undefined, order: undefined, challenges: [] });
  });
});

describe("Gateway API", () => {
  test("gateway states and listeners", () => {
    expect(gatewayState({ status: { conditions: [cond("Accepted", "True"), cond("Programmed", "True")] } }).label).toBe("Programmed");
    expect(gatewayState({ status: { conditions: [cond("Accepted", "True"), cond("Programmed", "False", "AddressNotAssigned")] } })).toMatchObject({
      label: "Not programmed",
      tone: "warning",
    });
    expect(gatewayState({ status: { conditions: [cond("Accepted", "False", "InvalidParameters")] } }).tone).toBe("destructive");
    expect(gatewayState({}).label).toBe("Pending");

    const listeners = gatewayListeners({
      spec: {
        listeners: [
          { name: "https", protocol: "HTTPS", port: 443, hostname: "*.acme.dev", tls: { certificateRefs: [{ name: "wildcard" }] } },
          { name: "http", protocol: "HTTP", port: 80 },
        ],
      },
      status: { listeners: [{ name: "https", attachedRoutes: 3, conditions: [cond("ResolvedRefs", "False", "InvalidCertificateRef", "secret missing")] }] },
    });
    expect(listeners[0]).toMatchObject({ endpoint: "HTTPS:443", hostname: "*.acme.dev", attachedRoutes: 3, tls: "wildcard" });
    expect(listeners[0].problem).toBe("Invalid certificate ref: secret missing");
    expect(listeners[1]).toMatchObject({ endpoint: "HTTP:80", hostname: undefined, attachedRoutes: undefined });
  });

  const route = {
    kind: "HTTPRoute",
    metadata: { name: "checkout", namespace: "checkout" },
    spec: {
      parentRefs: [{ name: "public", namespace: "platform", sectionName: "https" }, { name: "internal" }],
      rules: [
        { matches: [{ path: { type: "PathPrefix", value: "/api/" }, method: "GET", headers: [{ name: "x-canary", value: "1" }] }], backendRefs: [{ name: "api", port: 8080, weight: 90 }, { name: "api-canary", port: 8080, weight: 10 }] },
        { matches: [{ path: { type: "Exact", value: "/login" } }], filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] },
        { backendRefs: [{ name: "web", port: 3000 }] },
      ],
    },
    status: {
      parents: [
        { parentRef: { name: "public", namespace: "platform", sectionName: "https" }, conditions: [cond("Accepted", "True"), cond("ResolvedRefs", "True")] },
        { parentRef: { name: "internal" }, conditions: [cond("Accepted", "False", "NotAllowedByListeners", "namespace not allowed")] },
      ],
    },
  };

  test("route parents and the worst state", () => {
    const parents = routeParents(route);
    expect(parents.map((p) => [p.label, p.state.label])).toEqual([
      ["platform/public › https", "Accepted"],
      ["internal", "Not accepted"],
    ]);
    expect(routeState(route)).toMatchObject({ label: "Not accepted", tone: "destructive", message: "internal: namespace not allowed" });
    expect(routeState({ spec: { parentRefs: [{ name: "gw" }] } }).label).toBe("Pending");
    expect(
      routeState({ spec: { parentRefs: [{ name: "gw" }] }, status: { parents: [{ parentRef: { name: "gw" }, conditions: [cond("Accepted", "True"), cond("ResolvedRefs", "False", "BackendNotFound")] }] } })
    ).toMatchObject({ label: "Backend missing", tone: "warning" });
  });

  test("rules as flows", () => {
    const rules = routeRules(route);
    expect(rules[0].matches.map(matchInWords)).toEqual(["GET /api/* · x-canary = 1"]);
    expect(rules[0].backends.map((b) => [b.label, b.percent])).toEqual([
      ["api:8080", 90],
      ["api-canary:8080", 10],
    ]);
    expect(rules[1].matches.map(matchInWords)).toEqual(["/login"]);
    expect(rules[1].filters).toEqual(["Redirect to https:// (301)"]);
    expect(rules[1].backends).toEqual([]);
    expect(rules[2].matches.map(matchInWords)).toEqual(["Any path"]);
    expect(rules[2].backends[0].percent).toBeUndefined();

    const grpc = routeRules({ kind: "GRPCRoute", spec: { rules: [{ matches: [{ method: { service: "acme.Ledger", method: "Post" } }] }, {}] } });
    expect(grpc.map((r) => matchInWords(r.matches[0]))).toEqual(["acme.Ledger/Post", "Any method"]);
  });

  test("routes of a gateway, problems first", () => {
    const gateway = { metadata: { name: "public", namespace: "platform" } };
    const ok = { metadata: { name: "a", namespace: "platform" }, spec: { parentRefs: [{ name: "public" }] }, status: { parents: [{ parentRef: { name: "public" }, conditions: [cond("Accepted", "True")] }] } };
    const elsewhere = { metadata: { name: "b", namespace: "default" }, spec: { parentRefs: [{ name: "public" }] } };
    const found = routesOfGateway(gateway, [ok, route, elsewhere]);
    expect(found.map((f) => f.route.metadata.name)).toEqual(["a", "checkout"]);
  });
});

describe("Karpenter", () => {
  test("usage against limits", () => {
    const [cpu, memory] = nodePoolUsage({
      spec: { limits: { cpu: "1000", memory: "1000Gi" } },
      status: { resources: { cpu: "48", memory: "192Gi" } },
    });
    expect(cpu).toMatchObject({ text: "48 of 1000 cores", short: "48 / 1000", percent: 5 });
    expect(memory).toMatchObject({ text: "192Gi of 1000Gi", percent: 19 });
    expect(nodePoolUsage({ status: { resources: { cpu: "1500m" } } })[0]).toMatchObject({ text: "1.5 cores", percent: undefined });
  });

  test("disruption in words", () => {
    expect(
      disruptionInWords({
        spec: {
          disruption: {
            consolidationPolicy: "WhenEmptyOrUnderutilized",
            consolidateAfter: "1m",
            budgets: [{ nodes: "10%" }, { nodes: "0", schedule: "0 9 * * mon-fri", duration: "8h", reasons: ["Underutilized"] }, { nodes: "1" }],
          },
          template: { spec: { expireAfter: "720h" } },
        },
      })
    ).toEqual({
      policy: "Consolidates empty or underutilized nodes after 1 minute",
      expiry: "Replaces nodes after 30 days",
      budgets: ["At most 10% of nodes at a time", "No disruptions (underutilized), Mon–Fri from 09:00 for 8 hours", "At most 1 node at a time"],
    });
    expect(disruptionInWords({ spec: { disruption: { consolidateAfter: "Never" }, template: { spec: { expireAfter: "Never" } } } })).toMatchObject({
      policy: "Never consolidates nodes",
      expiry: "Never replaces nodes for age",
    });
  });

  test("requirements", () => {
    expect(
      requirementsInWords({
        spec: {
          template: {
            spec: {
              requirements: [
                { key: "karpenter.sh/capacity-type", operator: "In", values: ["spot", "on-demand"] },
                { key: "karpenter.k8s.aws/instance-generation", operator: "Gt", values: ["5"] },
                { key: "example.com/team", operator: "NotIn", values: ["a"] },
              ],
            },
          },
        },
      })
    ).toEqual([
      { label: "Capacity", value: "spot, on-demand" },
      { label: "Generation", value: "more than 5" },
      { label: "example.com/team", value: "not a" },
    ]);
  });

  test("node claim states", () => {
    const up = [cond("Launched", "True"), cond("Registered", "True"), cond("Initialized", "True"), cond("Ready", "True")];
    expect(nodeClaimState({ status: { conditions: up } }).label).toBe("Ready");
    expect(nodeClaimState({ status: { conditions: [...up, cond("Drifted", "True", "NodeClassDrifted")] } }).label).toBe("Drifted");
    expect(nodeClaimState({ status: { conditions: [cond("Launched", "Unknown")] } })).toMatchObject({ label: "Launching", busy: true });
    expect(nodeClaimState({ status: { conditions: [cond("Launched", "False", "InsufficientCapacityError", "no capacity")] } })).toMatchObject({
      label: "Launch failed",
      tone: "destructive",
    });
    expect(nodeClaimState({ status: { conditions: [cond("Launched", "True"), cond("Registered", "True")] } }).label).toBe("Initializing");
    expect(nodeClaimState({ metadata: { deletionTimestamp: at(0) } }).label).toBe("Terminating");
    expect(capacityType({ metadata: { labels: { "karpenter.sh/capacity-type": "on-demand" } } })).toBe("On-demand");
    expect(capacityType({ metadata: { labels: { "karpenter.sh/capacity-type": "spot" } } })).toBe("Spot");
  });
});

describe("KEDA", () => {
  test("triggers in words", () => {
    expect(
      triggerInWords({ type: "prometheus", metadata: { query: 'sum(rate(http_requests_total{service="api"}[2m]))', threshold: "100" } })
    ).toBe("Prometheus: http_requests_total > 100");
    expect(triggerInWords({ type: "cpu", metricType: "Utilization", metadata: { value: "70" } })).toBe("CPU at 70%");
    expect(triggerInWords({ type: "kafka", metadata: { topic: "orders", lagThreshold: "50" } })).toBe("Kafka lag on orders > 50");
    expect(triggerInWords({ type: "aws-sqs-queue", metadata: { queueURL: "https://sqs.eu-west-1.amazonaws.com/1/jobs", queueLength: "5" } })).toBe(
      "SQS jobs > 5 messages"
    );
    expect(triggerInWords({ type: "cron", metadata: { start: "0 8 * * 1-5", end: "0 18 * * 1-5", desiredReplicas: "4" } })).toBe(
      "Schedule Mon–Fri 08:00–18:00 → 4 replicas"
    );
    expect(triggerInWords({ type: "redis", metadata: { listLength: "5" } })).toBe("Redis list > 5");
    expect(triggerInWords({ type: "new-thing", metadata: { threshold: "3" } })).toBe("New thing > 3");
    expect(promMetricName("histogram_quantile(0.99, sum by (le) (rate(latency_bucket[5m])))")).toBe("latency_bucket");
  });

  test("states", () => {
    const so = (conditions: any[], annotations?: any) => ({ metadata: { annotations }, status: { conditions } });
    expect(scaledObjectState(so([cond("Ready", "True"), cond("Active", "True")]))).toMatchObject({ label: "Active", tone: "success" });
    expect(scaledObjectState(so([cond("Ready", "True"), cond("Active", "False")]))).toMatchObject({ label: "Idle", tone: "muted" });
    expect(scaledObjectState(so([cond("Ready", "True"), cond("Fallback", "True")])).label).toBe("Fallback");
    expect(scaledObjectState(so([cond("Ready", "False", "ScaledObjectCheckFailed")])).tone).toBe("destructive");
    expect(scaledObjectState(so([cond("Ready", "True")], { "autoscaling.keda.sh/paused": "true" }))).toMatchObject({
      label: "Paused",
      tone: "info",
    });
    expect(scaledObjectState(so([], { "autoscaling.keda.sh/paused-replicas": "2" })).message).toBe("Held at 2 replicas until resumed.");
  });

  test("pause and resume", () => {
    expect(isPaused({ metadata: { annotations: { "autoscaling.keda.sh/paused": "true" } } })).toBe(true);
    expect(isPaused({ metadata: { annotations: { "autoscaling.keda.sh/paused": "false" } } })).toBe(false);
    expect(pausePatch(true)).toEqual({ metadata: { annotations: { "autoscaling.keda.sh/paused": "true" } } });
    expect(pausePatch(false)).toEqual({
      metadata: { annotations: { "autoscaling.keda.sh/paused": null, "autoscaling.keda.sh/paused-replicas": null } },
    });
  });

  test("replica range and credentials", () => {
    expect(replicaRange({ spec: { minReplicaCount: 2, maxReplicaCount: 20 } })).toMatchObject({ min: 2, max: 20, text: "2–20" });
    expect(replicaRange({ spec: {} })).toMatchObject({ min: 0, max: 100 });
    expect(
      authSourcesInWords({ spec: { secretTargetRef: [{ name: "creds" }, { name: "creds" }], podIdentity: { provider: "aws" } } })
    ).toEqual(["Secret creds", "AWS pod identity"]);
  });
});

describe("External Secrets", () => {
  test("states, refresh and force sync", () => {
    expect(externalSecretState({ status: { conditions: [cond("Ready", "True", "SecretSynced")] } }).label).toBe("Synced");
    expect(externalSecretState({ status: { conditions: [cond("Ready", "False", "SecretSyncedError", "not found")] } })).toMatchObject({
      label: "Sync failed",
      tone: "destructive",
      message: "not found",
    });
    expect(refreshInWords({ spec: { refreshInterval: "15m" } })).toBe("Every 15 minutes");
    expect(refreshInWords({ spec: { refreshInterval: "0" } })).toBe("Only once");
    expect(refreshInWords({ spec: {} })).toBe("Every hour");
    expect(forceSyncPatch(NOW)).toEqual({ metadata: { annotations: { "force-sync": String(NOW / 1000) } } });
  });

  test("store providers", () => {
    expect(storeProvider({ spec: { provider: { aws: { service: "SecretsManager", region: "eu-west-1" } } } })).toEqual({
      name: "AWS Secrets Manager",
      detail: "eu-west-1",
    });
    expect(storeProvider({ spec: { provider: { aws: { service: "ParameterStore" } } } })?.name).toBe("AWS Parameter Store");
    expect(storeProvider({ spec: { provider: { vault: { server: "https://vault.acme.dev:8200" } } } })).toEqual({
      name: "HashiCorp Vault",
      detail: "vault.acme.dev:8200",
    });
    expect(storeProvider({ spec: { provider: { onepassword: {} } } })?.name).toBe("1Password");
    expect(storeProvider({ spec: {} })).toBeNull();
  });
});

describe("Prometheus Operator", () => {
  test("monitors and rules in words", () => {
    expect(
      monitorTargetInWords({ kind: "ServiceMonitor", spec: { selector: { matchLabels: { app: "api" } }, namespaceSelector: { matchNames: ["payments"] } } })
    ).toBe("Services app=api in payments");
    expect(monitorTargetInWords({ kind: "PodMonitor", spec: { selector: {}, namespaceSelector: { any: true } } })).toBe(
      "Pods with any labels in all namespaces"
    );
    expect(
      rulesInWords({ spec: { groups: [{ rules: [{ alert: "A" }, { alert: "B" }, { record: "r" }] }, { rules: [{ alert: "C" }] }] } })
    ).toBe("3 alerts, 1 recording rule");
    expect(rulesInWords({ spec: { groups: [] } })).toBe("No rules");
  });
});
