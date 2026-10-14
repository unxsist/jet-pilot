/*
 * Harness fixtures and mocks for the operator views (cert-manager, Gateway
 * API, Karpenter, KEDA, External Secrets, Prometheus Operator) plus a few
 * CRD groups that only get printer columns (Velero, CloudNativePG, Istio,
 * an in-house platform group) or land in "More resources".
 *
 * - Adds the objects to the first context and their API groups to
 *   discovery; CRD objects (with additionalPrinterColumns) to the
 *   customresourcedefinitions list.
 * - `kube_request` routes: CRDs by name, lists and objects of these groups,
 *   and patches (renew a certificate, sync an external secret, pause a
 *   scaled object) that play out like the controllers would.
 *
 * Dev-only: never imported by the app itself.
 */
import { API_GROUPS, CLUSTERS, CONTEXTS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";

type Emit = (key: string, change: { added?: any[]; modified?: any[]; deleted?: any[] }) => void;

const NOW = Date.now();
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const ago = (seconds: number) => iso(-seconds);
const ahead = (seconds: number) => iso(seconds);

let uidCounter = 0;
const uid = () => `0e7a${(++uidCounter).toString(16).padStart(4, "0")}-5c3d-4e2f-8a1b-${(uidCounter * 7919).toString(16).padStart(12, "0")}`;

const meta = (name: string, namespace: string | undefined, created: number, extra: any = {}) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: uid(),
  creationTimestamp: ago(created),
  generation: 1,
  ...extra,
});

const cond = (type: string, status: string, reason = "", message = "", since = DAY) => ({
  type,
  status,
  ...(reason ? { reason } : {}),
  ...(message ? { message } : {}),
  lastTransitionTime: ago(since),
});

const owner = (object: any) => ({
  apiVersion: object.apiVersion,
  kind: object.kind,
  name: object.metadata.name,
  uid: object.metadata.uid,
  controller: true,
});

/* ------------------------------------------------------------ cert-manager -- */

const CM = "cert-manager.io/v1";
const ACME = "acme.cert-manager.io/v1";

function certificate(
  name: string,
  namespace: string,
  o: {
    dnsNames: string[];
    issuer: [string, string];
    lifetimeDays: number;
    issuedAgo: number;
    renewBefore?: number;
    conditions: any[];
    secretName?: string;
    privateKey?: any;
    isCA?: boolean;
    created?: number;
  }
) {
  const lifetime = o.lifetimeDays * DAY;
  const renewBefore = o.renewBefore ?? Math.round(lifetime / 3);
  const notBefore = -o.issuedAgo;
  const notAfter = notBefore + lifetime;
  return {
    apiVersion: CM,
    kind: "Certificate",
    metadata: meta(name, namespace, o.created ?? o.issuedAgo + 11 * DAY),
    spec: {
      secretName: o.secretName ?? `${name}-tls`,
      dnsNames: o.dnsNames,
      issuerRef: { kind: o.issuer[0], name: o.issuer[1], group: "cert-manager.io" },
      ...(o.privateKey ? { privateKey: o.privateKey } : {}),
      ...(o.isCA ? { isCA: true, commonName: o.dnsNames[0] } : {}),
      ...(o.lifetimeDays !== 90 ? { duration: `${o.lifetimeDays * 24}h` } : {}),
    },
    status: {
      notBefore: iso(notBefore),
      notAfter: iso(notAfter),
      renewalTime: iso(notAfter - renewBefore),
      revision: 2,
      conditions: o.conditions,
    },
  };
}

function certManagerObjects() {
  const ready = (since = 30 * DAY) => cond("Ready", "True", "Ready", "Certificate is up to date and has not expired", since);
  const certificates = [
    certificate("api-acme-dev", "payments", {
      dnsNames: ["api.acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-prod"],
      lifetimeDays: 90,
      issuedAgo: 37 * DAY,
      secretName: "api-acme-dev-tls",
      conditions: [ready(37 * DAY)],
    }),
    certificate("checkout-tls", "checkout", {
      dnsNames: ["checkout.acme.dev", "www.checkout.acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-prod"],
      lifetimeDays: 90,
      issuedAgo: 67 * DAY,
      secretName: "checkout-tls",
      conditions: [
        ready(67 * DAY),
        cond(
          "Issuing",
          "False",
          "Failed",
          'The certificate request has failed to complete and will be retried: Failed to wait for order resource "checkout-tls-2-3870159412" to become ready: order is in "invalid" state',
          4 * HOUR
        ),
      ],
    }),
    certificate("grafana-acme-dev", "monitoring", {
      dnsNames: ["grafana.acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-dns"],
      lifetimeDays: 90,
      issuedAgo: 92 * DAY,
      conditions: [
        cond("Ready", "False", "Expired", "Certificate expired on " + new Date(NOW - 2 * DAY * 1000).toUTCString(), 2 * DAY),
        cond("Issuing", "True", "Expired", "Renewing certificate as renewal was scheduled at " + ago(32 * DAY), 40 * MIN),
      ],
    }),
    certificate("flags-acme-dev", "platform", {
      dnsNames: ["flags.acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-prod"],
      lifetimeDays: 90,
      issuedAgo: 0,
      created: 3 * MIN,
      conditions: [
        cond("Ready", "False", "DoesNotExist", "Issuing certificate as Secret does not exist", 3 * MIN),
        cond("Issuing", "True", "DoesNotExist", "Issuing certificate as Secret does not exist", 3 * MIN),
      ],
    }),
    certificate("wildcard-acme-dev", "platform", {
      dnsNames: ["*.acme.dev", "acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-dns"],
      lifetimeDays: 90,
      issuedAgo: 19 * DAY,
      privateKey: { algorithm: "ECDSA", size: 256 },
      conditions: [ready(19 * DAY)],
    }),
    certificate("legacy-acme-dev", "default", {
      dnsNames: ["legacy.acme.dev"],
      issuer: ["ClusterIssuer", "letsencrypt-staging"],
      lifetimeDays: 90,
      issuedAgo: 85 * DAY,
      conditions: [ready(85 * DAY)],
    }),
    certificate("internal-ca", "cert-manager", {
      dnsNames: ["Acme Internal CA"],
      issuer: ["ClusterIssuer", "selfsigned"],
      lifetimeDays: 3650,
      issuedAgo: 210 * DAY,
      renewBefore: 90 * DAY,
      isCA: true,
      privateKey: { algorithm: "ECDSA", size: 384 },
      conditions: [ready(210 * DAY)],
    }),
    certificate("ledger-mtls", "payments", {
      dnsNames: ["ledger.payments.svc.cluster.local"],
      issuer: ["Issuer", "internal-ca-issuer"],
      lifetimeDays: 1,
      issuedAgo: 8 * HOUR,
      renewBefore: 8 * HOUR,
      conditions: [ready(8 * HOUR)],
    }),
  ];
  // The CA certificate has a common name, not a DNS name.
  const ca = certificates.find((c) => c.metadata.name === "internal-ca")!;
  ca.spec.dnsNames = [];

  const acmeIssuer = (name: string, server: string, solvers: any[], conditions: any[]) => ({
    apiVersion: CM,
    kind: "ClusterIssuer",
    metadata: meta(name, undefined, 200 * DAY),
    spec: { acme: { server, email: "platform@acme.dev", privateKeySecretRef: { name: `${name}-account` }, solvers } },
    status: { acme: { uri: `${server.replace("/directory", "")}/acct/1847291` }, conditions },
  });
  const clusterissuers = [
    acmeIssuer(
      "letsencrypt-prod",
      "https://acme-v02.api.letsencrypt.org/directory",
      [{ http01: { ingress: { ingressClassName: "nginx" } } }],
      [cond("Ready", "True", "ACMEAccountRegistered", "The ACME account was registered with the ACME server", 200 * DAY)]
    ),
    acmeIssuer(
      "letsencrypt-dns",
      "https://acme-v02.api.letsencrypt.org/directory",
      [{ dns01: { route53: { region: "eu-west-1" } }, selector: { dnsZones: ["acme.dev"] } }],
      [cond("Ready", "True", "ACMEAccountRegistered", "The ACME account was registered with the ACME server", 150 * DAY)]
    ),
    acmeIssuer(
      "letsencrypt-staging",
      "https://acme-staging-v02.api.letsencrypt.org/directory",
      [{ http01: { ingress: { ingressClassName: "nginx" } } }],
      [
        cond(
          "Ready",
          "False",
          "ErrRegisterACMEAccount",
          "Failed to register ACME account: 400 urn:ietf:params:acme:error:invalidContact: Error creating new account :: contact email has forbidden domain \"example.com\"",
          12 * DAY
        ),
      ]
    ),
    {
      apiVersion: CM,
      kind: "ClusterIssuer",
      metadata: meta("selfsigned", undefined, 210 * DAY),
      spec: { selfSigned: {} },
      status: { conditions: [cond("Ready", "True", "IsReady", "", 210 * DAY)] },
    },
  ];
  const issuers = [
    {
      apiVersion: CM,
      kind: "Issuer",
      metadata: meta("internal-ca-issuer", "payments", 200 * DAY),
      spec: { ca: { secretName: "internal-ca" } },
      status: { conditions: [cond("Ready", "True", "KeyPairVerified", "Signing CA verified", 200 * DAY)] },
    },
    {
      apiVersion: CM,
      kind: "Issuer",
      metadata: meta("vault-issuer", "platform", 90 * DAY),
      spec: { vault: { server: "https://vault.acme.dev", path: "pki_int/sign/acme-dev", auth: { kubernetes: { role: "cert-manager", mountPath: "/v1/auth/kubernetes" } } } },
      status: { conditions: [cond("Ready", "True", "VaultVerified", "Vault verified", 90 * DAY)] },
    },
  ];

  const request = (cert: any, revision: number, conditions: any[], created: number) => ({
    apiVersion: CM,
    kind: "CertificateRequest",
    metadata: meta(`${cert.metadata.name}-${revision}`, cert.metadata.namespace, created, {
      annotations: {
        "cert-manager.io/certificate-name": cert.metadata.name,
        "cert-manager.io/certificate-revision": String(revision),
      },
      ownerReferences: [owner(cert)],
    }),
    spec: { issuerRef: cert.spec.issuerRef, username: "system:serviceaccount:cert-manager:cert-manager", request: "LS0tLS1CRUdJTi..." },
    status: { conditions },
  });
  const approved = (since: number) => cond("Approved", "True", "cert-manager.io", "Certificate request has been approved by cert-manager.io", since);
  const byName = (name: string) => certificates.find((c) => c.metadata.name === name)!;

  const certificaterequests = [
    request(byName("api-acme-dev"), 1, [approved(37 * DAY), cond("Ready", "True", "Issued", "Certificate fetched from issuer successfully", 37 * DAY)], 37 * DAY),
    request(byName("checkout-tls"), 1, [approved(67 * DAY), cond("Ready", "True", "Issued", "Certificate fetched from issuer successfully", 67 * DAY)], 67 * DAY),
    request(byName("checkout-tls"), 2, [approved(5 * HOUR), cond("Ready", "False", "Failed", 'Failed to wait for order resource "checkout-tls-2-3870159412" to become ready: order is in "invalid" state', 4 * HOUR)], 5 * HOUR),
    request(byName("grafana-acme-dev"), 3, [approved(40 * MIN), cond("Ready", "False", "Pending", 'Waiting on certificate issuance from order monitoring/grafana-acme-dev-3-1958373421: "pending"', 40 * MIN)], 40 * MIN),
    request(byName("flags-acme-dev"), 1, [approved(3 * MIN), cond("Ready", "False", "Pending", 'Waiting on certificate issuance from order platform/flags-acme-dev-1-2265478713: "pending"', 3 * MIN)], 3 * MIN),
    request(byName("ledger-mtls"), 42, [approved(8 * HOUR), cond("Ready", "True", "Issued", "Certificate fetched from issuer successfully", 8 * HOUR)], 8 * HOUR),
  ];

  const order = (requestName: string, suffix: string, state: string, reason: string, created: number) => {
    const req = certificaterequests.find((r) => r.metadata.name === requestName)!;
    const cert = byName(req.metadata.annotations["cert-manager.io/certificate-name"]);
    return {
      apiVersion: ACME,
      kind: "Order",
      metadata: meta(`${requestName}-${suffix}`, req.metadata.namespace, created, { ownerReferences: [owner(req)] }),
      spec: { dnsNames: cert.spec.dnsNames, issuerRef: cert.spec.issuerRef, request: "LS0tLS1CRUdJTi..." },
      status: { state, ...(reason ? { reason } : {}), url: `https://acme-v02.api.letsencrypt.org/acme/order/1847291/${suffix}` },
    };
  };
  const orders = [
    order("checkout-tls-2", "3870159412", "invalid", "", 5 * HOUR),
    order("grafana-acme-dev-3", "1958373421", "pending", "", 40 * MIN),
    order("flags-acme-dev-1", "2265478713", "pending", "", 3 * MIN),
  ];

  const challenge = (o: any, dnsName: string, type: "HTTP-01" | "DNS-01", state: string, presented: boolean, reason: string, created: number, n: number) => {
    const issuer = clusterissuers.find((i) => i.metadata.name === o.spec.issuerRef.name)!;
    return {
      apiVersion: ACME,
      kind: "Challenge",
      metadata: meta(`${o.metadata.name}-${n}`, o.metadata.namespace, created, { ownerReferences: [owner(o)] }),
      spec: {
        dnsName,
        type,
        token: "x9F2kQmR7vLwT3pZ8nB1cY6hJ4sD0aE5",
        key: "x9F2kQmR7vLwT3pZ8nB1cY6hJ4sD0aE5.Ab3",
        url: `https://acme-v02.api.letsencrypt.org/acme/chall-v3/3149882/${n}`,
        solver: (issuer.spec as any).acme.solvers[0],
        issuerRef: o.spec.issuerRef,
      },
      status: { processing: state === "pending", presented, state, reason },
    };
  };
  const [checkoutOrder, grafanaOrder, flagsOrder] = orders;
  const challenges = [
    challenge(
      checkoutOrder,
      "checkout.acme.dev",
      "HTTP-01",
      "invalid",
      false,
      "Error accepting authorization: acme: authorization error for checkout.acme.dev: 403 urn:ietf:params:acme:error:unauthorized: 52.18.4.120: Invalid response from http://checkout.acme.dev/.well-known/acme-challenge/x9F2kQmR7vLwT3pZ8nB1cY6hJ4sD0aE5: 404",
      5 * HOUR,
      1
    ),
    challenge(checkoutOrder, "www.checkout.acme.dev", "HTTP-01", "valid", false, "Successfully authorized domain", 5 * HOUR, 2),
    challenge(
      grafanaOrder,
      "grafana.acme.dev",
      "DNS-01",
      "pending",
      true,
      'Waiting for DNS-01 challenge propagation: DNS record for "grafana.acme.dev" not yet propagated',
      40 * MIN,
      1
    ),
    challenge(
      flagsOrder,
      "flags.acme.dev",
      "HTTP-01",
      "pending",
      true,
      "Waiting for HTTP-01 challenge propagation: wrong status code '503', expected '200'",
      2 * MIN,
      1
    ),
  ];

  return { certificates, clusterissuers, issuers, certificaterequests, orders, challenges };
}

/* ------------------------------------------------------------ Gateway API -- */

const GW = "gateway.networking.k8s.io/v1";

function gatewayObjects() {
  const accepted = (since = 20 * DAY) => [
    cond("Accepted", "True", "Accepted", "Route was valid", since),
    cond("ResolvedRefs", "True", "ResolvedRefs", "All references resolved", since),
  ];
  const parentStatus = (parentRef: any, conditions: any[]) => ({
    parentRef,
    controllerName: "istio.io/gateway-controller",
    conditions,
  });
  const publicRef = (sectionName?: string) => ({
    group: "gateway.networking.k8s.io",
    kind: "Gateway",
    name: "public-gateway",
    namespace: "platform",
    ...(sectionName ? { sectionName } : {}),
  });
  const backend = (name: string, port: number, weight?: number) => ({ name, port, ...(weight !== undefined ? { weight } : {}) });
  const prefix = (value: string) => ({ path: { type: "PathPrefix", value } });

  const gatewayclasses = [
    {
      apiVersion: GW,
      kind: "GatewayClass",
      metadata: meta("istio", undefined, 120 * DAY),
      spec: { controllerName: "istio.io/gateway-controller", description: "The default Istio GatewayClass" },
      status: { conditions: [cond("Accepted", "True", "Accepted", "Handled by Istio controller", 120 * DAY)] },
    },
    {
      apiVersion: GW,
      kind: "GatewayClass",
      metadata: meta("envoy", undefined, 30 * DAY),
      spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
      status: { conditions: [cond("Accepted", "True", "Accepted", "Valid GatewayClass", 30 * DAY)] },
    },
  ];

  const gateways = [
    {
      apiVersion: GW,
      kind: "Gateway",
      metadata: meta("public-gateway", "platform", 60 * DAY),
      spec: {
        gatewayClassName: "istio",
        listeners: [
          { name: "http", port: 80, protocol: "HTTP", hostname: "*.acme.dev", allowedRoutes: { namespaces: { from: "All" } } },
          { name: "https", port: 443, protocol: "HTTPS", hostname: "*.acme.dev", tls: { mode: "Terminate", certificateRefs: [{ kind: "Secret", name: "wildcard-acme-dev-tls" }] }, allowedRoutes: { namespaces: { from: "All" } } },
        ],
      },
      status: {
        addresses: [{ type: "Hostname", value: "a1b2c3d4e5f6-1840572931.eu-west-1.elb.amazonaws.com" }],
        conditions: [cond("Accepted", "True", "Accepted", "Resource accepted", 60 * DAY), cond("Programmed", "True", "Programmed", "Resource programmed, assigned to service(s) public-gateway-istio.platform.svc.cluster.local:443", 60 * DAY)],
        listeners: [
          { name: "http", attachedRoutes: 1, supportedKinds: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }], conditions: [cond("Accepted", "True"), cond("Programmed", "True"), cond("ResolvedRefs", "True")] },
          { name: "https", attachedRoutes: 4, supportedKinds: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }], conditions: [cond("Accepted", "True"), cond("Programmed", "True"), cond("ResolvedRefs", "True")] },
        ],
      },
    },
    {
      apiVersion: GW,
      kind: "Gateway",
      metadata: meta("internal-gateway", "platform", 6 * DAY),
      spec: {
        gatewayClassName: "envoy",
        listeners: [
          { name: "http", port: 8080, protocol: "HTTP", hostname: "*.internal.acme.dev" },
          { name: "grpc", port: 9090, protocol: "HTTP", hostname: "ledger.internal.acme.dev" },
        ],
      },
      status: {
        conditions: [
          cond("Accepted", "True", "Accepted", "The Gateway has been scheduled by Envoy Gateway", 6 * DAY),
          cond("Programmed", "False", "AddressNotAssigned", "No addresses have been assigned to the Gateway", 6 * DAY),
        ],
        listeners: [
          { name: "http", attachedRoutes: 0, conditions: [cond("Accepted", "True"), cond("Programmed", "True")] },
          { name: "grpc", attachedRoutes: 1, conditions: [cond("Accepted", "True"), cond("Programmed", "True")] },
        ],
      },
    },
  ];

  const route = (name: string, namespace: string, spec: any, parents: any[], created = 20 * DAY) => ({
    apiVersion: GW,
    kind: "HTTPRoute",
    metadata: meta(name, namespace, created),
    spec,
    status: { parents },
  });
  const httproutes = [
    route(
      "checkout",
      "checkout",
      {
        parentRefs: [publicRef("https")],
        hostnames: ["checkout.acme.dev"],
        rules: [
          { matches: [{ path: { type: "PathPrefix", value: "/api" }, headers: [{ name: "x-canary", value: "always" }] }], backendRefs: [backend("checkout-api-canary", 8080)] },
          { matches: [{ ...prefix("/api"), method: "GET" }, { ...prefix("/api"), method: "POST" }], backendRefs: [backend("checkout-api", 8080, 90), backend("checkout-api-canary", 8080, 10)] },
          { matches: [prefix("/images")], filters: [{ type: "URLRewrite", urlRewrite: { path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" } } }], backendRefs: [backend("image-resizer", 80)] },
          { matches: [prefix("/")], backendRefs: [backend("checkout-web", 3000)] },
        ],
      },
      [parentStatus(publicRef("https"), accepted())]
    ),
    route(
      "payments-api",
      "payments",
      {
        parentRefs: [publicRef("https")],
        hostnames: ["api.acme.dev"],
        rules: [
          { matches: [prefix("/v1/payments")], backendRefs: [backend("payments-api", 8080)] },
          { matches: [prefix("/v1/ledger")], backendRefs: [backend("ledger", 9000)] },
        ],
      },
      [parentStatus(publicRef("https"), accepted(41 * DAY))],
      41 * DAY
    ),
    route(
      "feature-flags",
      "platform",
      {
        parentRefs: [publicRef("https")],
        hostnames: ["flags.acme.dev"],
        rules: [{ matches: [prefix("/")], backendRefs: [backend("feature-flags", 8080)] }],
      },
      [
        parentStatus(publicRef("https"), [
          cond("Accepted", "True", "Accepted", "Route was valid", 9 * HOUR),
          cond("ResolvedRefs", "False", "BackendNotFound", 'backend(feature-flags-v2.platform.svc.cluster.local) not found', 9 * HOUR),
        ]),
      ],
      9 * HOUR
    ),
    route(
      "https-redirect",
      "platform",
      {
        parentRefs: [publicRef("http")],
        hostnames: ["*.acme.dev"],
        rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] }],
      },
      [parentStatus(publicRef("http"), accepted(60 * DAY))],
      60 * DAY
    ),
    route(
      "legacy-site",
      "default",
      {
        parentRefs: [publicRef("https")],
        hostnames: ["www.acme-legacy.com"],
        rules: [{ matches: [prefix("/")], backendRefs: [backend("nginx", 80)] }],
      },
      [
        parentStatus(publicRef("https"), [
          cond("Accepted", "False", "NoMatchingListenerHostname", 'No hostnames matched parent hostname "*.acme.dev"', 2 * DAY),
          cond("ResolvedRefs", "True", "ResolvedRefs", "All references resolved", 2 * DAY),
        ]),
      ],
      2 * DAY
    ),
  ];
  // The feature flags route points at a backend that doesn't exist.
  httproutes[2].spec.rules[0].backendRefs = [backend("feature-flags-v2", 8080)];

  const grpcroutes = [
    {
      apiVersion: GW,
      kind: "GRPCRoute",
      metadata: meta("ledger", "payments", 6 * DAY),
      spec: {
        parentRefs: [{ name: "internal-gateway", namespace: "platform", sectionName: "grpc" }],
        hostnames: ["ledger.internal.acme.dev"],
        rules: [
          { matches: [{ method: { service: "acme.ledger.v1.Ledger", method: "PostEntry" } }], backendRefs: [backend("ledger", 9000)] },
          { matches: [{ method: { service: "acme.ledger.v1.Ledger" } }], backendRefs: [backend("ledger", 9000)] },
        ],
      },
      status: {
        parents: [
          {
            parentRef: { name: "internal-gateway", namespace: "platform", sectionName: "grpc" },
            controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
            conditions: accepted(6 * DAY),
          },
        ],
      },
    },
  ];

  return { gatewayclasses, gateways, httproutes, grpcroutes };
}

/* -------------------------------------------------------------- Karpenter -- */

function karpenterObjects() {
  const KS = "karpenter.sh/v1";
  const pool = (name: string, o: any) => ({
    apiVersion: KS,
    kind: "NodePool",
    metadata: meta(name, undefined, o.created ?? 90 * DAY),
    spec: {
      ...(o.weight !== undefined ? { weight: o.weight } : {}),
      ...(o.limits ? { limits: o.limits } : {}),
      disruption: o.disruption,
      template: {
        metadata: { labels: o.labels ?? {} },
        spec: {
          nodeClassRef: { group: "karpenter.k8s.aws", kind: "EC2NodeClass", name: o.nodeClass },
          expireAfter: o.expireAfter ?? "720h",
          requirements: o.requirements,
          ...(o.taints ? { taints: o.taints } : {}),
        },
      },
    },
    status: { resources: o.resources, conditions: o.conditions },
  });
  const readyPool = [
    cond("ValidationSucceeded", "True", "ValidationSucceeded", "", 90 * DAY),
    cond("NodeClassReady", "True", "NodeClassReady", "", 90 * DAY),
    cond("Ready", "True", "Ready", "", 90 * DAY),
  ];
  const nodepools = [
    pool("general-purpose", {
      weight: 10,
      nodeClass: "default",
      limits: { cpu: "1000", memory: "1000Gi" },
      resources: { cpu: "48", memory: "192Gi", nodes: "6", pods: "110", "ephemeral-storage": "480Gi" },
      disruption: {
        consolidationPolicy: "WhenEmptyOrUnderutilized",
        consolidateAfter: "1m",
        budgets: [{ nodes: "10%" }, { nodes: "0", schedule: "0 9 * * mon-fri", duration: "8h", reasons: ["Underutilized"] }],
      },
      requirements: [
        { key: "karpenter.sh/capacity-type", operator: "In", values: ["spot", "on-demand"] },
        { key: "kubernetes.io/arch", operator: "In", values: ["amd64", "arm64"] },
        { key: "karpenter.k8s.aws/instance-category", operator: "In", values: ["c", "m", "r"] },
        { key: "karpenter.k8s.aws/instance-generation", operator: "Gt", values: ["5"] },
      ],
      conditions: readyPool,
    }),
    pool("gpu", {
      weight: 50,
      nodeClass: "gpu",
      limits: { cpu: "64", memory: "512Gi", "nvidia.com/gpu": "8" },
      resources: { cpu: "58", memory: "464Gi", nodes: "2", "nvidia.com/gpu": "8" },
      disruption: { consolidationPolicy: "WhenEmpty", consolidateAfter: "30m", budgets: [{ nodes: "1" }] },
      expireAfter: "Never",
      requirements: [
        { key: "karpenter.k8s.aws/instance-family", operator: "In", values: ["g5", "g6"] },
        { key: "karpenter.sh/capacity-type", operator: "In", values: ["on-demand"] },
      ],
      taints: [{ key: "nvidia.com/gpu", effect: "NoSchedule" }],
      conditions: readyPool,
    }),
    pool("batch-spot", {
      nodeClass: "batch",
      created: 2 * DAY,
      resources: { cpu: "0", memory: "0", nodes: "0" },
      disruption: { consolidationPolicy: "WhenEmptyOrUnderutilized", consolidateAfter: "0s" },
      requirements: [{ key: "karpenter.sh/capacity-type", operator: "In", values: ["spot"] }],
      conditions: [
        cond("ValidationSucceeded", "True", "ValidationSucceeded", "", 2 * DAY),
        cond("NodeClassReady", "False", "NodeClassNotFound", 'EC2NodeClass "batch" not found', 2 * DAY),
        cond("Ready", "False", "UnhealthyDependents", 'NodeClassReady=False: EC2NodeClass "batch" not found', 2 * DAY),
      ],
    }),
  ];

  const nodeNames = [
    "ip-10-0-12-34.eu-west-1.compute.internal",
    "ip-10-0-45-118.eu-west-1.compute.internal",
    "ip-10-0-78-201.eu-west-1.compute.internal",
    "ip-10-0-91-7.eu-west-1.compute.internal",
  ];
  const claim = (name: string, o: any) => ({
    apiVersion: KS,
    kind: "NodeClaim",
    metadata: meta(name, undefined, o.age, {
      labels: {
        "karpenter.sh/nodepool": o.pool,
        "node.kubernetes.io/instance-type": o.type,
        "karpenter.sh/capacity-type": o.capacity,
        "topology.kubernetes.io/zone": o.zone,
        "kubernetes.io/arch": o.type.startsWith("c7g") ? "arm64" : "amd64",
      },
      ownerReferences: [{ apiVersion: KS, kind: "NodePool", name: o.pool, uid: nodepools.find((p) => p.metadata.name === o.pool)!.metadata.uid }],
    }),
    spec: { nodeClassRef: { group: "karpenter.k8s.aws", kind: "EC2NodeClass", name: o.pool === "gpu" ? "gpu" : "default" } },
    status: {
      ...(o.node ? { nodeName: o.node, providerID: `aws:///${o.zone}/i-0${(o.age * 7919).toString(16).slice(0, 16)}` } : {}),
      imageID: "ami-0c1f3a7b9e2d48a51",
      capacity: o.capacityResources,
      conditions: o.conditions,
    },
  });
  const up = (age: number) => [
    cond("Launched", "True", "Launched", "", age),
    cond("Registered", "True", "Registered", "", age),
    cond("Initialized", "True", "Initialized", "", age),
    cond("Ready", "True", "Ready", "", age),
  ];
  const nodeclaims = [
    claim("general-purpose-x7k2p", { pool: "general-purpose", type: "m6i.xlarge", capacity: "spot", zone: "eu-west-1a", node: nodeNames[0], age: 12 * DAY, capacityResources: { cpu: "4", memory: "15155Mi", pods: "58" }, conditions: up(12 * DAY) }),
    claim("general-purpose-b9fqd", { pool: "general-purpose", type: "c7g.2xlarge", capacity: "on-demand", zone: "eu-west-1b", node: nodeNames[1], age: 9 * DAY, capacityResources: { cpu: "8", memory: "15155Mi", pods: "58" }, conditions: up(9 * DAY) }),
    claim("general-purpose-4tq8z", { pool: "general-purpose", type: "r6i.large", capacity: "spot", zone: "eu-west-1c", node: nodeNames[2], age: 31 * DAY, capacityResources: { cpu: "2", memory: "15155Mi", pods: "29" }, conditions: [...up(31 * DAY), cond("Drifted", "True", "NodeClassDrifted", "EC2NodeClass changed: AMI is no longer selected", 3 * HOUR)] }),
    claim("general-purpose-m2kd9", { pool: "general-purpose", type: "m6i.large", capacity: "spot", zone: "eu-west-1a", age: 40, capacityResources: { cpu: "2", memory: "7542Mi" }, conditions: [cond("Launched", "Unknown", "Launching", "", 40)] }),
    claim("general-purpose-zz9q1", {
      pool: "general-purpose",
      type: "c7g.4xlarge",
      capacity: "spot",
      zone: "eu-west-1a",
      age: 6 * MIN,
      capacityResources: { cpu: "16", memory: "30310Mi" },
      conditions: [
        cond(
          "Launched",
          "False",
          "InsufficientCapacityError",
          "creating instance, insufficient capacity, with fleet error(s), InsufficientInstanceCapacity: We currently do not have sufficient c7g.4xlarge capacity in the Availability Zone you requested (eu-west-1a).",
          5 * MIN
        ),
      ],
    }),
    claim("gpu-h8w2c", { pool: "gpu", type: "g5.2xlarge", capacity: "on-demand", zone: "eu-west-1b", node: nodeNames[3], age: 4 * DAY, capacityResources: { cpu: "8", memory: "31440Mi", "nvidia.com/gpu": "1" }, conditions: up(4 * DAY) }),
  ];

  const nodeClass = (name: string, alias: string, created: number) => ({
    apiVersion: "karpenter.k8s.aws/v1",
    kind: "EC2NodeClass",
    metadata: meta(name, undefined, created),
    spec: {
      role: "KarpenterNodeRole-prod-eu-west-1",
      amiSelectorTerms: [{ alias }],
      subnetSelectorTerms: [{ tags: { "karpenter.sh/discovery": "prod-eu-west-1" } }],
      securityGroupSelectorTerms: [{ tags: { "karpenter.sh/discovery": "prod-eu-west-1" } }],
    },
    status: {
      subnets: [
        { id: "subnet-0a1b2c3d4e5f60718", zone: "eu-west-1a" },
        { id: "subnet-0b2c3d4e5f6071829", zone: "eu-west-1b" },
        { id: "subnet-0c3d4e5f607182930", zone: "eu-west-1c" },
      ],
      securityGroups: [{ id: "sg-04f1e2d3c4b5a6978", name: "eks-cluster-sg-prod" }],
      amis: [{ id: "ami-0c1f3a7b9e2d48a51", name: "amazon-eks-node-al2023-x86_64-standard-1.31-v20261001" }],
      instanceProfile: `prod-eu-west-1_${name}`,
      conditions: [cond("Ready", "True", "Ready", "", created)],
    },
  });
  const ec2nodeclasses = [nodeClass("default", "al2023@latest", 90 * DAY), nodeClass("gpu", "bottlerocket@latest", 40 * DAY)];

  return { nodepools, nodeclaims, ec2nodeclasses };
}

/* ------------------------------------------------------------------- KEDA -- */

function kedaObjects() {
  const KEDA = "keda.sh/v1alpha1";
  const scaled = (name: string, namespace: string, o: any) => ({
    apiVersion: KEDA,
    kind: "ScaledObject",
    metadata: meta(name, namespace, o.created ?? 30 * DAY, o.annotations ? { annotations: o.annotations } : {}),
    spec: {
      scaleTargetRef: { name: o.target ?? name },
      ...(o.min !== undefined ? { minReplicaCount: o.min } : {}),
      maxReplicaCount: o.max,
      ...(o.polling ? { pollingInterval: o.polling } : {}),
      ...(o.fallback ? { fallback: o.fallback } : {}),
      triggers: o.triggers,
    },
    status: {
      scaleTargetKind: "apps/v1.Deployment",
      scaleTargetGVKR: { group: "apps", version: "v1", kind: "Deployment", resource: "deployments" },
      hpaName: `keda-hpa-${name}`,
      conditions: o.conditions,
    },
  });
  const healthy = (active: boolean, since = DAY) => [
    cond("Ready", "True", "ScaledObjectReady", "ScaledObject is defined correctly and is ready for scaling", 30 * DAY),
    cond("Active", active ? "True" : "False", active ? "ScalerActive" : "ScalerNotActive", active ? "Scaling is performed because triggers are active" : "Scaling is not performed because triggers are not active", since),
    cond("Fallback", "False", "NoFallbackFound", "No fallbacks are active on this scaled object", 30 * DAY),
    cond("Paused", "False", "ScaledObjectUnpaused", "", 30 * DAY),
  ];
  const prometheus = (query: string, threshold: string) => ({
    type: "prometheus",
    metadata: { serverAddress: "http://prometheus-operated.monitoring.svc:9090", query, threshold },
  });

  const scaledobjects = [
    scaled("checkout-api", "checkout", {
      min: 2,
      max: 20,
      triggers: [
        { ...prometheus('sum(rate(http_requests_total{service="checkout-api"}[2m]))', "100"), authenticationRef: { name: "prometheus-auth" } },
        { type: "cpu", metricType: "Utilization", metadata: { value: "70" } },
      ],
      conditions: healthy(true, 2 * HOUR),
    }),
    scaled("payments-worker", "payments", {
      min: 1,
      max: 30,
      polling: 15,
      triggers: [{ type: "kafka", metadata: { bootstrapServers: "kafka-bootstrap.data:9092", consumerGroup: "payments-worker", topic: "payment-events", lagThreshold: "50" }, authenticationRef: { name: "kafka-auth" } }],
      conditions: healthy(true, 20 * MIN),
    }),
    scaled("image-resizer", "checkout", {
      min: 0,
      max: 15,
      annotations: { "autoscaling.keda.sh/paused": "true" },
      triggers: [{ type: "aws-sqs-queue", metadata: { queueURL: "https://sqs.eu-west-1.amazonaws.com/123456789012/resize-jobs", queueLength: "5", awsRegion: "eu-west-1" }, authenticationRef: { name: "aws-sqs" } }],
      conditions: [
        cond("Ready", "True", "ScaledObjectReady", "ScaledObject is defined correctly and is ready for scaling", 30 * DAY),
        cond("Active", "False", "ScalerNotActive", "Scaling is not performed because triggers are not active", 2 * HOUR),
        cond("Paused", "True", "ScaledObjectPaused", "ScaledObject is paused", 2 * HOUR),
      ],
    }),
    scaled("ledger", "payments", {
      min: 2,
      max: 6,
      triggers: [
        { type: "cron", metadata: { timezone: "Europe/Amsterdam", start: "0 8 * * 1-5", end: "0 18 * * 1-5", desiredReplicas: "4" } },
        { type: "cpu", metricType: "Utilization", metadata: { value: "80" } },
      ],
      conditions: healthy(false, 5 * HOUR),
    }),
    scaled("cart-service", "checkout", {
      min: 2,
      max: 12,
      fallback: { failureThreshold: 3, replicas: 6 },
      triggers: [{ type: "rabbitmq", metadata: { host: "amqp://rabbitmq.data:5672", queueName: "cart-events", mode: "QueueLength", value: "20" } }],
      conditions: [
        cond("Ready", "True", "ScaledObjectReady", "ScaledObject is defined correctly and is ready for scaling", 30 * DAY),
        cond("Active", "False", "ScalerNotActive", "", 25 * MIN),
        cond("Fallback", "True", "FallbackExists", "At least one trigger is falling back on this scaled object: dial tcp 10.100.42.7:5672: connect: connection refused", 25 * MIN),
      ],
    }),
    scaled("feature-flags", "platform", {
      min: 1,
      max: 4,
      created: 9 * HOUR,
      triggers: [prometheus('sum(rate(flag_evaluations_total[1m]))', "500")],
      conditions: [
        cond("Ready", "False", "ScaledObjectCheckFailed", 'ScaledObject doesn\'t have correct triggers specification: error parsing prometheus metadata: no serverAddress given', 9 * HOUR),
        cond("Active", "Unknown", "", "", 9 * HOUR),
      ],
    }),
  ];
  // The flags trigger lost its server address in the last edit.
  delete scaledobjects[5].spec.triggers[0].metadata.serverAddress;

  const scaledjobs = [
    {
      apiVersion: KEDA,
      kind: "ScaledJob",
      metadata: meta("video-transcode", "checkout", 14 * DAY),
      spec: {
        jobTargetRef: { template: { spec: { containers: [{ name: "transcode", image: "ghcr.io/acme/transcoder:v2.3.1" }], restartPolicy: "Never" } } },
        maxReplicaCount: 50,
        pollingInterval: 10,
        triggers: [{ type: "aws-sqs-queue", metadata: { queueURL: "https://sqs.eu-west-1.amazonaws.com/123456789012/transcode-jobs", queueLength: "1", awsRegion: "eu-west-1" }, authenticationRef: { name: "aws-sqs" } }],
      },
      status: { conditions: [cond("Ready", "True", "ScaledJobReady", "ScaledJob is defined correctly and is ready to scaling", 14 * DAY), cond("Active", "False", "ScalerNotActive", "", 3 * HOUR)] },
    },
  ];

  const triggerauthentications = [
    { apiVersion: KEDA, kind: "TriggerAuthentication", metadata: meta("prometheus-auth", "checkout", 30 * DAY), spec: { secretTargetRef: [{ parameter: "username", name: "prometheus-basic-auth", key: "username" }, { parameter: "password", name: "prometheus-basic-auth", key: "password" }] } },
    { apiVersion: KEDA, kind: "TriggerAuthentication", metadata: meta("kafka-auth", "payments", 30 * DAY), spec: { secretTargetRef: [{ parameter: "sasl", name: "kafka-sasl", key: "mechanism" }, { parameter: "password", name: "kafka-sasl", key: "password" }] } },
    { apiVersion: KEDA, kind: "TriggerAuthentication", metadata: meta("aws-sqs", "checkout", 30 * DAY), spec: { podIdentity: { provider: "aws" } } },
  ];
  const clustertriggerauthentications = [
    { apiVersion: KEDA, kind: "ClusterTriggerAuthentication", metadata: meta("vault-shared", undefined, 60 * DAY), spec: { hashiCorpVault: { address: "https://vault.acme.dev", authentication: "kubernetes", role: "keda" } } },
  ];

  return { scaledobjects, scaledjobs, triggerauthentications, clustertriggerauthentications };
}

/* ------------------------------------------------------- External Secrets -- */

function externalSecretObjects() {
  const ESO = "external-secrets.io/v1";
  const external = (name: string, namespace: string, o: any) => ({
    apiVersion: ESO,
    kind: "ExternalSecret",
    metadata: meta(name, namespace, o.created ?? 60 * DAY),
    spec: {
      refreshInterval: o.refresh ?? "1h",
      secretStoreRef: { kind: o.storeKind ?? "ClusterSecretStore", name: o.store },
      target: { name: o.target ?? name, creationPolicy: "Owner" },
      ...(o.data ? { data: o.data } : {}),
      ...(o.dataFrom ? { dataFrom: o.dataFrom } : {}),
    },
    status: {
      refreshTime: ago(o.synced),
      syncedResourceVersion: "1-8f2b0c1e5a",
      binding: { name: o.target ?? name },
      conditions: [o.failed ? cond("Ready", "False", "SecretSyncedError", o.failed, 2 * HOUR) : cond("Ready", "True", "SecretSynced", "secret synced", o.synced)],
    },
  });
  const externalsecrets = [
    external("postgres-credentials", "payments", { store: "aws-secrets-manager", synced: 14 * MIN, data: [{ secretKey: "password", remoteRef: { key: "prod/payments/postgres", property: "password" } }, { secretKey: "username", remoteRef: { key: "prod/payments/postgres", property: "username" } }] }),
    external("stripe-api-key", "payments", { store: "aws-secrets-manager", refresh: "15m", synced: 3 * MIN, data: [{ secretKey: "STRIPE_API_KEY", remoteRef: { key: "prod/payments/stripe", property: "api_key" } }] }),
    external("ledger-signing-key", "payments", {
      store: "aws-secrets-manager",
      synced: 2 * HOUR,
      data: [{ secretKey: "signing.key", remoteRef: { key: "prod/payments/ledger-signing-key" } }],
      failed: "could not get secret data from provider: error getting secret prod/payments/ledger-signing-key: ResourceNotFoundException: Secrets Manager can't find the specified secret.",
    }),
    external("checkout-config", "checkout", { store: "vault", refresh: "30m", synced: 22 * MIN, dataFrom: [{ extract: { key: "secret/data/checkout/prod" } }] }),
    external("grafana-oauth", "monitoring", { store: "vault", refresh: "0", synced: 40 * DAY, created: 40 * DAY, data: [{ secretKey: "client-secret", remoteRef: { key: "secret/data/grafana/oauth", property: "client_secret" } }] }),
    external("partner-api-tokens", "payments", { store: "payments-1password", storeKind: "SecretStore", synced: 6 * HOUR, data: [{ secretKey: "token", remoteRef: { key: "Partner API/token" } }], failed: 'error retrieving secret from store: 1Password Connect returned 401 Unauthorized: invalid bearer token' }),
  ];

  const clustersecretstores = [
    {
      apiVersion: ESO,
      kind: "ClusterSecretStore",
      metadata: meta("aws-secrets-manager", undefined, 200 * DAY),
      spec: { provider: { aws: { service: "SecretsManager", region: "eu-west-1", auth: { jwt: { serviceAccountRef: { name: "external-secrets", namespace: "external-secrets" } } } } } },
      status: { capabilities: "ReadWrite", conditions: [cond("Ready", "True", "Valid", "store validated", 200 * DAY)] },
    },
    {
      apiVersion: ESO,
      kind: "ClusterSecretStore",
      metadata: meta("vault", undefined, 150 * DAY),
      spec: { provider: { vault: { server: "https://vault.acme.dev", path: "secret", version: "v2", auth: { kubernetes: { role: "external-secrets", mountPath: "kubernetes" } } } } },
      status: { capabilities: "ReadWrite", conditions: [cond("Ready", "True", "Valid", "store validated", 150 * DAY)] },
    },
  ];
  const secretstores = [
    {
      apiVersion: ESO,
      kind: "SecretStore",
      metadata: meta("payments-1password", "payments", 20 * DAY),
      spec: { provider: { onepassword: { connectHost: "http://onepassword-connect.platform:8080", vaults: { Payments: 1 }, auth: { secretRef: { connectTokenSecretRef: { name: "onepassword-token", key: "token" } } } } } },
      status: { conditions: [cond("Ready", "False", "InvalidProviderConfig", "unable to validate store: 1Password Connect returned 401 Unauthorized", 6 * HOUR)] },
    },
  ];
  const pushsecrets = [
    {
      apiVersion: "external-secrets.io/v1alpha1",
      kind: "PushSecret",
      metadata: meta("wildcard-tls-to-vault", "platform", 19 * DAY),
      spec: { refreshInterval: "1h", secretStoreRefs: [{ kind: "ClusterSecretStore", name: "vault" }], selector: { secret: { name: "wildcard-acme-dev-tls" } }, data: [{ match: { secretKey: "tls.crt", remoteRef: { remoteKey: "secret/data/tls/wildcard" } } }] },
      status: { refreshTime: ago(31 * MIN), conditions: [cond("Ready", "True", "Synced", "PushSecret synced successfully", 19 * DAY)] },
    },
  ];
  return { externalsecrets, clustersecretstores, secretstores, pushsecrets };
}

/* ----------------------------------------------------- Prometheus Operator -- */

function prometheusObjects() {
  const MON = "monitoring.coreos.com/v1";
  const monitor = (name: string, namespace: string, selector: any, endpoints: any[], namespaces?: any) => ({
    apiVersion: MON,
    kind: "ServiceMonitor",
    metadata: meta(name, namespace, 80 * DAY, { labels: { release: "kube-prometheus-stack" } }),
    spec: { selector: { matchLabels: selector }, endpoints, ...(namespaces ? { namespaceSelector: namespaces } : {}) },
  });
  const servicemonitors = [
    monitor("payments-api", "payments", { "app.kubernetes.io/name": "payments-api" }, [{ port: "http-metrics", interval: "30s" }]),
    monitor("ingress-nginx-controller", "ingress-nginx", { "app.kubernetes.io/name": "ingress-nginx" }, [{ port: "metrics", interval: "15s" }]),
    monitor("cert-manager", "cert-manager", { "app.kubernetes.io/name": "cert-manager" }, [{ port: "tcp-prometheus-servicemonitor", interval: "60s" }]),
    monitor("kube-state-metrics", "monitoring", { "app.kubernetes.io/name": "kube-state-metrics" }, [{ port: "http", honorLabels: true }], { any: true }),
  ];
  const podmonitors = [
    {
      apiVersion: MON,
      kind: "PodMonitor",
      metadata: meta("checkout-workers", "checkout", 30 * DAY),
      spec: { selector: { matchLabels: { "app.kubernetes.io/part-of": "checkout" }, matchExpressions: [{ key: "tier", operator: "In", values: ["worker"] }] }, podMetricsEndpoints: [{ port: "metrics", path: "/internal/metrics", interval: "30s" }] },
    },
  ];
  const alert = (name: string, severity: string, forDuration: string, summary: string, expr: string) => ({
    alert: name,
    expr,
    for: forDuration,
    labels: { severity },
    annotations: { summary },
  });
  const prometheusrules = [
    {
      apiVersion: MON,
      kind: "PrometheusRule",
      metadata: meta("payments-alerts", "monitoring", 40 * DAY),
      spec: {
        groups: [
          {
            name: "payments.rules",
            rules: [
              alert("PaymentsHighErrorRate", "critical", "5m", "More than 2% of payment requests fail", 'sum(rate(http_requests_total{service="payments-api",code=~"5.."}[5m])) / sum(rate(http_requests_total{service="payments-api"}[5m])) > 0.02'),
              alert("PaymentsLatencyHigh", "warning", "10m", "p99 latency of payments is above 800ms", 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="payments-api"}[5m]))) > 0.8'),
              alert("LedgerLagging", "warning", "15m", "The ledger is more than 1000 entries behind", "ledger_replication_lag_entries > 1000"),
            ],
          },
          {
            name: "payments.recording",
            interval: "1m",
            rules: [
              { record: "service:http_requests:rate5m", expr: "sum by (service) (rate(http_requests_total[5m]))" },
              { record: "service:http_errors:rate5m", expr: 'sum by (service) (rate(http_requests_total{code=~"5.."}[5m]))' },
            ],
          },
        ],
      },
    },
    {
      apiVersion: MON,
      kind: "PrometheusRule",
      metadata: meta("cert-manager", "cert-manager", 120 * DAY),
      spec: {
        groups: [
          {
            name: "cert-manager",
            rules: [
              alert("CertManagerCertExpirySoon", "warning", "1h", "A certificate expires within 21 days", "avg by (exported_namespace, namespace, name) (certmanager_certificate_expiration_timestamp_seconds - time()) < (21 * 24 * 3600)"),
              alert("CertManagerCertNotReady", "critical", "10m", "A certificate is not ready to serve traffic", 'max by (name, exported_namespace, namespace, condition) (certmanager_certificate_ready_status{condition!="True"} == 1)'),
            ],
          },
        ],
      },
    },
    {
      apiVersion: MON,
      kind: "PrometheusRule",
      metadata: meta("kubernetes-apps", "monitoring", 88 * DAY),
      spec: {
        groups: [
          {
            name: "kubernetes-apps",
            rules: [
              alert("KubePodCrashLooping", "warning", "15m", "Pod is crash looping", 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) >= 1'),
              alert("KubePodNotReady", "warning", "15m", "Pod has been in a non-ready state for more than 15 minutes", 'sum by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Unknown"}) > 0'),
              alert("KubeDeploymentReplicasMismatch", "warning", "15m", "Deployment has not matched the expected number of replicas", "kube_deployment_spec_replicas != kube_deployment_status_replicas_available"),
              alert("KubeJobFailed", "warning", "15m", "Job failed to complete", "kube_job_failed > 0"),
            ],
          },
        ],
      },
    },
  ];
  const prometheuses = [
    {
      apiVersion: MON,
      kind: "Prometheus",
      metadata: meta("k8s", "monitoring", 88 * DAY),
      spec: { version: "v2.53.1", replicas: 2, retention: "15d" },
      status: { availableReplicas: 2, replicas: 2, conditions: [cond("Available", "True", "", "", 88 * DAY), cond("Reconciled", "True", "", "", 2 * HOUR)] },
    },
  ];
  const alertmanagers = [
    {
      apiVersion: MON,
      kind: "Alertmanager",
      metadata: meta("main", "monitoring", 88 * DAY),
      spec: { version: "v0.27.0", replicas: 2 },
      status: { availableReplicas: 1, replicas: 2, conditions: [cond("Available", "Degraded", "", "", 2 * HOUR), cond("Reconciled", "True", "", "", 2 * HOUR)] },
    },
  ];
  return { servicemonitors, podmonitors, prometheusrules, prometheuses, alertmanagers };
}

/* ----------------------------- printer-column-only groups and the long tail -- */

function otherObjects() {
  const VELERO = "velero.io/v1";
  const backup = (name: string, phase: string, started: number, o: any = {}) => ({
    apiVersion: VELERO,
    kind: "Backup",
    metadata: meta(name, "velero", started, { labels: o.schedule ? { "velero.io/schedule-name": o.schedule } : {} }),
    spec: { storageLocation: "default", ttl: "720h0m0s", includedNamespaces: o.namespaces ?? ["*"] },
    status: {
      phase,
      startTimestamp: ago(started),
      ...(phase !== "InProgress" ? { completionTimestamp: ago(started - 7 * MIN) } : {}),
      expiration: ahead(30 * DAY - started),
      errors: o.errors ?? 0,
      warnings: o.warnings ?? 0,
      progress: { itemsBackedUp: o.items ?? 2841, totalItems: o.total ?? 2841 },
    },
  });
  const backups = [
    backup("daily-20261015030012", "Completed", 21 * HOUR, { schedule: "daily", warnings: 2 }),
    backup("daily-20261014030008", "Completed", 45 * HOUR, { schedule: "daily" }),
    backup("daily-20261013030011", "PartiallyFailed", 69 * HOUR, { schedule: "daily", errors: 3, warnings: 5 }),
    backup("hourly-payments-20261015234501", "InProgress", 4 * MIN, { schedule: "hourly-payments", namespaces: ["payments"], items: 312, total: 940 }),
    backup("hourly-payments-20261015224500", "Completed", 64 * MIN, { schedule: "hourly-payments", namespaces: ["payments"], items: 940, total: 940 }),
    backup("before-postgres-upgrade", "Failed", 9 * DAY, { namespaces: ["payments"], errors: 1 }),
  ];
  const schedule = (name: string, cron: string, last: number, o: any = {}) => ({
    apiVersion: VELERO,
    kind: "Schedule",
    metadata: meta(name, "velero", 120 * DAY),
    spec: { schedule: cron, paused: !!o.paused, template: { ttl: "720h0m0s", includedNamespaces: o.namespaces ?? ["*"] } },
    status: { phase: "Enabled", lastBackup: ago(last) },
  });
  const schedules = [
    schedule("daily", "0 3 * * *", 21 * HOUR),
    schedule("hourly-payments", "@every 1h", 4 * MIN, { namespaces: ["payments"] }),
    schedule("weekly-full", "0 2 * * 0", 4 * DAY, { paused: true }),
  ];
  const restores = [
    { apiVersion: VELERO, kind: "Restore", metadata: meta("payments-restore-drill", "velero", 6 * DAY), spec: { backupName: "daily-20261009030004" }, status: { phase: "Completed", startTimestamp: ago(6 * DAY), completionTimestamp: ago(6 * DAY - 12 * MIN), errors: 0, warnings: 1 } },
  ];
  const backupstoragelocations = [
    { apiVersion: VELERO, kind: "BackupStorageLocation", metadata: meta("default", "velero", 200 * DAY), spec: { provider: "aws", default: true, objectStorage: { bucket: "acme-velero-prod", prefix: "eu-west-1" }, config: { region: "eu-west-1" } }, status: { phase: "Available", lastValidationTime: ago(40) } },
  ];

  const CNPG = "postgresql.cnpg.io/v1";
  const cnpgCluster = (name: string, namespace: string, instances: number, ready: number, phase: string, created: number) => ({
    apiVersion: CNPG,
    kind: "Cluster",
    metadata: meta(name, namespace, created),
    spec: { instances, imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "50Gi" } },
    status: { instances, readyInstances: ready, phase, currentPrimary: `${name}-1`, targetPrimary: `${name}-1` },
  });
  const clusters = [
    cnpgCluster("ledger-db", "payments", 3, 3, "Cluster in healthy state", 60 * DAY),
    cnpgCluster("checkout-db", "checkout", 2, 1, "Waiting for the instances to become active", 3 * DAY),
    cnpgCluster("keycloak-db", "platform", 1, 1, "Cluster in healthy state", 100 * DAY),
  ];
  const poolers = [
    { apiVersion: CNPG, kind: "Pooler", metadata: meta("ledger-db-rw", "payments", 60 * DAY), spec: { cluster: { name: "ledger-db" }, type: "rw", instances: 2, pgbouncer: { poolMode: "transaction" } }, status: { instances: 2 } },
  ];
  const scheduledbackups = [
    { apiVersion: CNPG, kind: "ScheduledBackup", metadata: meta("ledger-db-daily", "payments", 60 * DAY), spec: { schedule: "0 0 2 * * *", cluster: { name: "ledger-db" }, method: "barmanObjectStore" }, status: { lastScheduleTime: ago(22 * HOUR), nextScheduleTime: ahead(2 * HOUR) } },
  ];

  const ISTIO = "networking.istio.io/v1";
  const virtualservices = [
    { apiVersion: ISTIO, kind: "VirtualService", metadata: meta("ledger", "payments", 41 * DAY), spec: { hosts: ["ledger.payments.svc.cluster.local"], gateways: ["mesh"], http: [{ route: [{ destination: { host: "ledger", subset: "v1" }, weight: 100 }] }] } },
  ];
  const destinationrules = [
    { apiVersion: ISTIO, kind: "DestinationRule", metadata: meta("ledger", "payments", 41 * DAY), spec: { host: "ledger.payments.svc.cluster.local", subsets: [{ name: "v1", labels: { version: "v1" } }], trafficPolicy: { tls: { mode: "ISTIO_MUTUAL" } } } },
    { apiVersion: ISTIO, kind: "DestinationRule", metadata: meta("checkout-api", "checkout", 3 * DAY), spec: { host: "checkout-api.checkout.svc.cluster.local", trafficPolicy: { connectionPool: { http: { http1MaxPendingRequests: 100 } }, outlierDetection: { consecutive5xxErrors: 5, interval: "30s" } } } },
  ];
  const serviceentries = [
    { apiVersion: ISTIO, kind: "ServiceEntry", metadata: meta("stripe-api", "payments", 90 * DAY), spec: { hosts: ["api.stripe.com"], location: "MESH_EXTERNAL", resolution: "DNS", ports: [{ number: 443, name: "https", protocol: "TLS" }] } },
  ];
  const istioGateways = [
    { apiVersion: ISTIO, kind: "Gateway", metadata: meta("mesh-ingress", "platform", 120 * DAY), spec: { selector: { istio: "ingressgateway" }, servers: [{ port: { number: 443, name: "https", protocol: "HTTPS" }, hosts: ["*.mesh.acme.dev"], tls: { mode: "SIMPLE", credentialName: "mesh-acme-dev-tls" } }] } },
  ];
  const authorizationpolicies = [
    { apiVersion: "security.istio.io/v1", kind: "AuthorizationPolicy", metadata: meta("ledger-allow-payments", "payments", 41 * DAY), spec: { selector: { matchLabels: { "app.kubernetes.io/name": "ledger" } }, action: "ALLOW", rules: [{ from: [{ source: { principals: ["cluster.local/ns/payments/sa/payments-api"] } }] }] } },
  ];
  const peerauthentications = [
    { apiVersion: "security.istio.io/v1", kind: "PeerAuthentication", metadata: meta("default", "platform", 120 * DAY), spec: { mtls: { mode: "STRICT" } } },
  ];

  const PLATFORM = "platform.acme.dev/v1alpha1";
  const tenant = (name: string, team: string, namespaces: number, ready: boolean, created: number) => ({
    apiVersion: PLATFORM,
    kind: "Tenant",
    metadata: meta(name, undefined, created),
    spec: { team, quota: { cpu: "64", memory: "256Gi" } },
    status: {
      namespaceCount: namespaces,
      conditions: [ready ? cond("Ready", "True", "Provisioned", "", created) : cond("Ready", "False", "QuotaExceeded", "Requested quota exceeds the cluster budget", 3 * HOUR)],
    },
  });
  const tenants = [
    tenant("payments", "Payments", 3, true, 200 * DAY),
    tenant("checkout", "Checkout", 2, true, 180 * DAY),
    tenant("data-science", "Data", 0, false, 3 * HOUR),
  ];
  const environments = [
    { apiVersion: PLATFORM, kind: "Environment", metadata: meta("prod", undefined, 200 * DAY), spec: { tier: "production", region: "eu-west-1" }, status: { phase: "Active" } },
    { apiVersion: PLATFORM, kind: "Environment", metadata: meta("preview-pr-1842", undefined, 2 * HOUR), spec: { tier: "preview", region: "eu-west-1" }, status: { phase: "Provisioning" } },
  ];
  const eniconfigs = [
    { apiVersion: "crd.k8s.amazonaws.com/v1alpha1", kind: "ENIConfig", metadata: meta("eu-west-1a", undefined, 200 * DAY), spec: { subnet: "subnet-0a1b2c3d4e5f60718", securityGroups: ["sg-04f1e2d3c4b5a6978"] } },
  ];
  const securitygrouppolicies = [
    { apiVersion: "vpcresources.k8s.aws/v1beta1", kind: "SecurityGroupPolicy", metadata: meta("ledger-db-access", "payments", 60 * DAY), spec: { podSelector: { matchLabels: { "app.kubernetes.io/name": "ledger" } }, securityGroups: { groupIds: ["sg-0e9d8c7b6a5f4e3d2"] } } },
  ];

  return {
    backups,
    schedules,
    restores,
    backupstoragelocations,
    clusters,
    poolers,
    scheduledbackups,
    virtualservices,
    destinationrules,
    serviceentries,
    "gateways.networking.istio.io": istioGateways,
    authorizationpolicies,
    peerauthentications,
    tenants,
    environments,
    eniconfigs,
    securitygrouppolicies,
  };
}

/* -------------------------------------------- discovery and CRD objects -- */

interface Kind {
  plural: string;
  kind: string;
  namespaced?: boolean;
  /** additionalPrinterColumns of the CRD. */
  columns?: { name: string; jsonPath: string; type?: string; priority?: number; description?: string }[];
}

interface Group {
  name: string;
  version: string;
  kinds: Kind[];
}

const AGE = { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" };
const ready = (path = '.status.conditions[?(@.type=="Ready")].status') => ({ name: "Ready", type: "string", jsonPath: path });

/* Groups of this module; printer columns as the projects ship them (abridged). */
const GROUPS: Group[] = [
  {
    name: "cert-manager.io",
    version: "v1",
    kinds: [
      { plural: "certificates", kind: "Certificate", columns: [ready(), { name: "Secret", type: "string", jsonPath: ".spec.secretName" }, { name: "Issuer", type: "string", jsonPath: ".spec.issuerRef.name", priority: 1 }, AGE] },
      { plural: "certificaterequests", kind: "CertificateRequest", columns: [{ name: "Approved", type: "string", jsonPath: '.status.conditions[?(@.type=="Approved")].status' }, ready(), AGE] },
      { plural: "issuers", kind: "Issuer", columns: [ready(), AGE] },
      { plural: "clusterissuers", kind: "ClusterIssuer", namespaced: false, columns: [ready(), AGE] },
    ],
  },
  {
    name: "acme.cert-manager.io",
    version: "v1",
    kinds: [
      { plural: "orders", kind: "Order", columns: [{ name: "State", type: "string", jsonPath: ".status.state" }, AGE] },
      { plural: "challenges", kind: "Challenge", columns: [{ name: "State", type: "string", jsonPath: ".status.state" }, { name: "Domain", type: "string", jsonPath: ".spec.dnsName" }, AGE] },
    ],
  },
  {
    name: "gateway.networking.k8s.io",
    version: "v1",
    kinds: [
      { plural: "gateways", kind: "Gateway", columns: [{ name: "Class", type: "string", jsonPath: ".spec.gatewayClassName" }, { name: "Address", type: "string", jsonPath: ".status.addresses[*].value" }, { name: "Programmed", type: "string", jsonPath: '.status.conditions[?(@.type=="Programmed")].status' }, AGE] },
      { plural: "httproutes", kind: "HTTPRoute", columns: [{ name: "Hostnames", type: "string", jsonPath: ".spec.hostnames" }, AGE] },
      { plural: "grpcroutes", kind: "GRPCRoute", columns: [{ name: "Hostnames", type: "string", jsonPath: ".spec.hostnames" }, AGE] },
      { plural: "gatewayclasses", kind: "GatewayClass", namespaced: false, columns: [{ name: "Controller", type: "string", jsonPath: ".spec.controllerName" }, { name: "Accepted", type: "string", jsonPath: '.status.conditions[?(@.type=="Accepted")].status' }, AGE] },
    ],
  },
  {
    name: "karpenter.sh",
    version: "v1",
    kinds: [
      { plural: "nodepools", kind: "NodePool", namespaced: false, columns: [{ name: "NodeClass", type: "string", jsonPath: ".spec.template.spec.nodeClassRef.name" }, { name: "Nodes", type: "string", jsonPath: ".status.resources.nodes" }, ready(), AGE] },
      { plural: "nodeclaims", kind: "NodeClaim", namespaced: false, columns: [{ name: "Type", type: "string", jsonPath: '.metadata.labels.node\\.kubernetes\\.io/instance-type' }, { name: "Node", type: "string", jsonPath: ".status.nodeName" }, ready(), AGE] },
    ],
  },
  {
    name: "karpenter.k8s.aws",
    version: "v1",
    kinds: [{ plural: "ec2nodeclasses", kind: "EC2NodeClass", namespaced: false, columns: [ready(), AGE, { name: "Role", type: "string", jsonPath: ".spec.role", priority: 1 }] }],
  },
  {
    name: "keda.sh",
    version: "v1alpha1",
    kinds: [
      { plural: "scaledobjects", kind: "ScaledObject", columns: [{ name: "ScaleTargetKind", type: "string", jsonPath: ".status.scaleTargetKind" }, { name: "Min", type: "integer", jsonPath: ".spec.minReplicaCount" }, { name: "Max", type: "integer", jsonPath: ".spec.maxReplicaCount" }, ready(), { name: "Active", type: "string", jsonPath: '.status.conditions[?(@.type=="Active")].status' }, AGE] },
      { plural: "scaledjobs", kind: "ScaledJob", columns: [{ name: "Max", type: "integer", jsonPath: ".spec.maxReplicaCount" }, ready(), AGE] },
      { plural: "triggerauthentications", kind: "TriggerAuthentication", columns: [AGE] },
      { plural: "clustertriggerauthentications", kind: "ClusterTriggerAuthentication", namespaced: false, columns: [AGE] },
    ],
  },
  {
    name: "external-secrets.io",
    version: "v1",
    kinds: [
      { plural: "externalsecrets", kind: "ExternalSecret", columns: [{ name: "Store", type: "string", jsonPath: ".spec.secretStoreRef.name" }, { name: "Refresh Interval", type: "string", jsonPath: ".spec.refreshInterval" }, { name: "Status", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].reason' }, AGE] },
      { plural: "secretstores", kind: "SecretStore", columns: [AGE, { name: "Status", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].reason' }] },
      { plural: "clustersecretstores", kind: "ClusterSecretStore", namespaced: false, columns: [AGE, { name: "Status", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].reason' }] },
      { plural: "pushsecrets", kind: "PushSecret", columns: [AGE, { name: "Status", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].reason' }] },
    ],
  },
  {
    name: "monitoring.coreos.com",
    version: "v1",
    kinds: [
      { plural: "servicemonitors", kind: "ServiceMonitor", columns: [] },
      { plural: "podmonitors", kind: "PodMonitor", columns: [] },
      { plural: "prometheusrules", kind: "PrometheusRule", columns: [] },
      {
        plural: "prometheuses",
        kind: "Prometheus",
        columns: [
          { name: "Version", type: "string", jsonPath: ".spec.version", description: "The version of Prometheus" },
          { name: "Desired", type: "integer", jsonPath: ".spec.replicas", description: "The number of desired replicas" },
          { name: "Ready", type: "integer", jsonPath: ".status.availableReplicas", description: "The number of ready replicas" },
          { name: "Reconciled", type: "string", jsonPath: '.status.conditions[?(@.type == "Reconciled")].status' },
          { name: "Available", type: "string", jsonPath: '.status.conditions[?(@.type == "Available")].status' },
          AGE,
        ],
      },
      {
        plural: "alertmanagers",
        kind: "Alertmanager",
        columns: [
          { name: "Version", type: "string", jsonPath: ".spec.version", description: "The version of Alertmanager" },
          { name: "Replicas", type: "integer", jsonPath: ".spec.replicas", description: "The number of desired replicas" },
          { name: "Ready", type: "integer", jsonPath: ".status.availableReplicas", description: "The number of ready replicas" },
          { name: "Reconciled", type: "string", jsonPath: '.status.conditions[?(@.type == "Reconciled")].status' },
          { name: "Available", type: "string", jsonPath: '.status.conditions[?(@.type == "Available")].status' },
          AGE,
        ],
      },
    ],
  },
  {
    name: "velero.io",
    version: "v1",
    kinds: [
      {
        plural: "backups",
        kind: "Backup",
        columns: [
          { name: "Status", type: "string", jsonPath: ".status.phase", description: "Backup status, e.g. Completed or PartiallyFailed" },
          { name: "Errors", type: "integer", jsonPath: ".status.errors", description: "Errors during the backup" },
          { name: "Warnings", type: "integer", jsonPath: ".status.warnings", description: "Warnings during the backup" },
          { name: "Started", type: "date", jsonPath: ".status.startTimestamp", description: "When the backup started" },
          { name: "Expires", type: "date", jsonPath: ".status.expiration", description: "When the backup will be garbage collected" },
          { name: "Storage Location", type: "string", jsonPath: ".spec.storageLocation", priority: 1 },
          { name: "Namespaces", type: "string", jsonPath: ".spec.includedNamespaces", priority: 1 },
        ],
      },
      {
        plural: "schedules",
        kind: "Schedule",
        columns: [
          { name: "Status", type: "string", jsonPath: ".status.phase" },
          { name: "Schedule", type: "string", jsonPath: ".spec.schedule", description: "A cron expression" },
          { name: "Last Backup", type: "date", jsonPath: ".status.lastBackup" },
          { name: "Paused", type: "boolean", jsonPath: ".spec.paused" },
          AGE,
        ],
      },
      {
        plural: "restores",
        kind: "Restore",
        columns: [
          { name: "Backup", type: "string", jsonPath: ".spec.backupName" },
          { name: "Status", type: "string", jsonPath: ".status.phase" },
          { name: "Started", type: "date", jsonPath: ".status.startTimestamp" },
          { name: "Errors", type: "integer", jsonPath: ".status.errors" },
          AGE,
        ],
      },
      {
        plural: "backupstoragelocations",
        kind: "BackupStorageLocation",
        columns: [
          { name: "Phase", type: "string", jsonPath: ".status.phase" },
          { name: "Last Validated", type: "date", jsonPath: ".status.lastValidationTime" },
          { name: "Default", type: "boolean", jsonPath: ".spec.default" },
          AGE,
        ],
      },
    ],
  },
  {
    name: "postgresql.cnpg.io",
    version: "v1",
    kinds: [
      {
        plural: "clusters",
        kind: "Cluster",
        columns: [
          AGE,
          { name: "Instances", type: "integer", jsonPath: ".status.instances", description: "Number of instances" },
          { name: "Ready", type: "integer", jsonPath: ".status.readyInstances", description: "Number of ready instances" },
          { name: "Status", type: "string", jsonPath: ".status.phase", description: "Cluster current status" },
          { name: "Primary", type: "string", jsonPath: ".status.currentPrimary", description: "Primary pod" },
        ],
      },
      { plural: "poolers", kind: "Pooler", columns: [AGE, { name: "Cluster", type: "string", jsonPath: ".spec.cluster.name" }, { name: "Type", type: "string", jsonPath: ".spec.type" }] },
      { plural: "scheduledbackups", kind: "ScheduledBackup", columns: [AGE, { name: "Cluster", type: "string", jsonPath: ".spec.cluster.name" }, { name: "Last Backup", type: "date", jsonPath: ".status.lastScheduleTime" }] },
    ],
  },
  {
    name: "networking.istio.io",
    version: "v1",
    kinds: [
      { plural: "virtualservices", kind: "VirtualService", columns: [{ name: "Gateways", type: "string", jsonPath: ".spec.gateways" }, { name: "Hosts", type: "string", jsonPath: ".spec.hosts" }, AGE] },
      { plural: "destinationrules", kind: "DestinationRule", columns: [{ name: "Host", type: "string", jsonPath: ".spec.host", description: "The name of a service from the service registry" }, AGE] },
      { plural: "gateways", kind: "Gateway", columns: [AGE] },
      { plural: "serviceentries", kind: "ServiceEntry", columns: [{ name: "Hosts", type: "string", jsonPath: ".spec.hosts" }, { name: "Location", type: "string", jsonPath: ".spec.location" }, { name: "Resolution", type: "string", jsonPath: ".spec.resolution" }, AGE] },
    ],
  },
  {
    name: "security.istio.io",
    version: "v1",
    kinds: [
      { plural: "authorizationpolicies", kind: "AuthorizationPolicy", columns: [{ name: "Action", type: "string", jsonPath: ".spec.action", description: "The operation to take." }, AGE] },
      { plural: "peerauthentications", kind: "PeerAuthentication", columns: [{ name: "Mode", type: "string", jsonPath: ".spec.mtls.mode", description: "Defines the mTLS mode used for peer authentication." }, AGE] },
    ],
  },
  {
    name: "platform.acme.dev",
    version: "v1alpha1",
    kinds: [
      { plural: "tenants", kind: "Tenant", namespaced: false, columns: [ready(), { name: "Team", type: "string", jsonPath: ".spec.team" }, { name: "Namespaces", type: "integer", jsonPath: ".status.namespaceCount" }, AGE] },
      { plural: "environments", kind: "Environment", namespaced: false, columns: [{ name: "Tier", type: "string", jsonPath: ".spec.tier" }, { name: "Phase", type: "string", jsonPath: ".status.phase" }, AGE] },
    ],
  },
  { name: "crd.k8s.amazonaws.com", version: "v1alpha1", kinds: [{ plural: "eniconfigs", kind: "ENIConfig", namespaced: false }] },
  { name: "vpcresources.k8s.aws", version: "v1beta1", kinds: [{ plural: "securitygrouppolicies", kind: "SecurityGroupPolicy", columns: [{ name: "Security-Group-Ids", type: "string", jsonPath: ".spec.securityGroups.groupIds" }, AGE] }] },
];

/** Cluster-scoped kinds of this module (setup.ts: like the backend's discovery). */
export const OPERATOR_CLUSTER_SCOPED = GROUPS.flatMap((g) => g.kinds.filter((k) => k.namespaced === false).map((k) => k.plural));

/** apiVersion per fixture list (watch subscriptions report it). */
export const OPERATOR_API_VERSIONS: Record<string, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.kinds.map((k) => [k.plural, `${g.name}/${g.version}`]))
);

/* Fixture lists keyed `plural.group`: plurals another group serves too. */
export const QUALIFIED_KEYS = new Set(["gateways.networking.istio.io"]);

const resource = (k: Kind) => ({
  name: k.plural,
  singularName: k.kind.toLowerCase(),
  namespaced: k.namespaced !== false,
  kind: k.kind,
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
});

const crd = (group: Group, k: Kind) => ({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: meta(`${k.plural}.${group.name}`, undefined, 120 * DAY),
  spec: {
    group: group.name,
    names: { plural: k.plural, singular: k.kind.toLowerCase(), kind: k.kind, listKind: `${k.kind}List` },
    scope: k.namespaced === false ? "Cluster" : "Namespaced",
    versions: [
      { name: group.version, served: true, storage: true, ...(k.columns?.length ? { additionalPrinterColumns: k.columns } : {}), schema: { openAPIV3Schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true } }, subresources: { status: {} } },
    ],
  },
  status: { acceptedNames: { plural: k.plural, kind: k.kind }, storedVersions: [group.version] },
});

/* --------------------------------------------------------------- mocks -- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* JSON merge patch (RFC 7386). */
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export function createOperatorMocks(emit: Emit) {
  const context = CONTEXTS[0].name;
  const cluster: Record<string, any[]> = CLUSTERS[context] as any;
  const fixtures = {
    ...certManagerObjects(),
    ...gatewayObjects(),
    ...karpenterObjects(),
    ...kedaObjects(),
    ...externalSecretObjects(),
    ...prometheusObjects(),
    ...otherObjects(),
  };
  for (const [key, items] of Object.entries(fixtures)) cluster[key] = items as any[];

  // Discovery: extend groups the fixtures already list, add the others.
  for (const group of GROUPS) {
    const known = API_GROUPS.find((g) => g.name === group.name);
    if (known) {
      for (const k of group.kinds) {
        if (!known.resources.some((r) => r.name === k.plural)) known.resources.push(resource(k));
      }
    } else {
      API_GROUPS.push({ name: group.name, version: `${group.name}/${group.version}`, resources: group.kinds.map(resource) });
    }
  }
  cluster.customresourcedefinitions = [
    ...(cluster.customresourcedefinitions ?? []),
    ...GROUPS.flatMap((group) => group.kinds.map((k) => crd(group, k))),
  ];

  const keyOf = (plural: string, group: string) =>
    QUALIFIED_KEYS.has(`${plural}.${group}`) ? `${plural}.${group}` : plural;
  const listFor = (request: { context: string }, key: string) =>
    request.context === context ? cluster[key] ?? [] : [];

  /* Replaces the object (new resourceVersion) and tells its watchers. */
  let version = 90_000;
  const update = (key: string, object: any, change: (o: any) => any) => {
    const list = cluster[key] ?? [];
    const index = list.findIndex((o) => o.metadata?.uid === object.metadata?.uid);
    if (index < 0) return null;
    const next = change(structuredClone(list[index]));
    next.metadata = { ...next.metadata, resourceVersion: String(++version) };
    list[index] = next;
    emit(key, { modified: [next] });
    return next;
  };

  /* cert-manager: an issuance takes a moment, then the certificate is fresh. */
  const playRenew = async (key: string, cert: any) => {
    await sleep(2500);
    update(key, cert, (c) => {
      const lifetime = (new Date(c.status.notAfter).getTime() - new Date(c.status.notBefore).getTime()) || 90 * DAY * 1000;
      const now = Date.now();
      c.status.notBefore = new Date(now).toISOString();
      c.status.notAfter = new Date(now + lifetime).toISOString();
      c.status.renewalTime = new Date(now + (lifetime * 2) / 3).toISOString();
      c.status.revision = (c.status.revision ?? 1) + 1;
      c.status.conditions = [
        { type: "Ready", status: "True", reason: "Ready", message: "Certificate is up to date and has not expired", lastTransitionTime: new Date(now).toISOString() },
      ];
      return c;
    });
  };

  /* External Secrets: a refresh, which fails again for the missing secret. */
  const playSync = async (key: string, secret: any) => {
    await sleep(900);
    update(key, secret, (s) => {
      s.status.refreshTime = new Date().toISOString();
      return s;
    });
  };

  /* /apis/<one of these groups>/<version>[/namespaces/<ns>]/<plural>[/<name>[/status]] */
  const groups = [...GROUPS.map((g) => g.name), "apiextensions.k8s.io"].map((g) => g.replace(/\./g, "\\.")).join("|");
  const PATH = new RegExp(`^/apis/(${groups})/([^/]+)/(?:namespaces/([^/]+)/)?([a-z0-9]+)(?:/([^/]+))?(?:/(status))?$`);

  registerKubeRoutes([
    {
      // Lists and objects of the groups above (and CRDs by name).
      method: "GET",
      path: PATH,
      handle: (request, match) => {
        const [, group, , namespace, plural, name] = match;
        const items = listFor(request, keyOf(plural!, group!)).filter(
          (o) => !namespace || o.metadata?.namespace === decodeURIComponent(namespace)
        );
        if (!name) return { apiVersion: `${group}/v1`, kind: "List", metadata: {}, items };
        const object = items.find((o) => o.metadata?.name === decodeURIComponent(name));
        if (!object) throw kubeError(404, `${plural}.${group} "${name}" not found`, "NotFound");
        return object;
      },
    },
    {
      // One core / apps object: a Service, Secret or Node a panel links to.
      method: "GET",
      path: /^\/(?:api\/v1|apis\/apps\/v1)\/(?:namespaces\/([^/]+)\/)?([a-z0-9]+)\/([^/]+)$/,
      handle: (request, match) => {
        const [, namespace, plural, name] = match;
        const object = listFor(request, plural!).find(
          (o) => o.metadata?.name === decodeURIComponent(name!) && (!namespace || o.metadata?.namespace === decodeURIComponent(namespace))
        );
        if (!object) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        return object;
      },
    },
    {
      method: "PATCH",
      path: PATH,
      handle: (request, match) => {
        const [, group, , namespace, plural, name] = match;
        const key = keyOf(plural!, group!);
        const object = listFor(request, key).find(
          (o) => o.metadata?.name === decodeURIComponent(name ?? "") && (o.metadata?.namespace ?? "") === decodeURIComponent(namespace ?? "")
        );
        if (!object) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        const patched = update(key, object, (o) => mergePatch(o, request.body));
        const issuing = patched.status?.conditions?.find((c: any) => c.type === "Issuing" && c.reason === "ManuallyTriggered");
        if (plural === "certificates" && issuing) void playRenew(key, patched);
        if (plural === "externalsecrets" && request.body?.metadata?.annotations?.["force-sync"]) void playSync(key, patched);
        return patched;
      },
    },
  ]);
}
