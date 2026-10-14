/*
 * Services, their endpoints and what routes to them (pure, unit tested):
 * EndpointSlices flattened to ready / not-ready addresses, Ingress rules as
 * host → path → backend, and the Ingresses / HTTPRoutes pointing at a
 * Service.
 */

export interface Endpoint {
  addresses: string[];
  ready: boolean;
  terminating: boolean;
  nodeName?: string;
  /** The pod behind it, usually. */
  targetRef?: { kind?: string; name?: string; namespace?: string; uid?: string };
}

/** The endpoints of a Service from its EndpointSlices (deduplicated). */
export function serviceEndpoints(service: any, slices: any[]): Endpoint[] {
  const name = service?.metadata?.name;
  const namespace = service?.metadata?.namespace;
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const slice of slices) {
    if (slice?.metadata?.namespace !== namespace) continue;
    if (slice?.metadata?.labels?.["kubernetes.io/service-name"] !== name) continue;
    for (const endpoint of slice.endpoints ?? []) {
      const key = endpoint.targetRef?.uid ?? (endpoint.addresses ?? []).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const conditions = endpoint.conditions ?? {};
      endpoints.push({
        addresses: endpoint.addresses ?? [],
        // A missing `ready` means ready (the API's own default).
        ready: conditions.ready !== false && conditions.terminating !== true,
        terminating: conditions.terminating === true,
        nodeName: endpoint.nodeName,
        targetRef: endpoint.targetRef,
      });
    }
  }
  return endpoints;
}

/** "80 → 8080", "443 → https", "53". */
export function portMapping(port: { port: number; targetPort?: number | string }): string {
  const target = port.targetPort;
  return target === undefined || target === port.port ? String(port.port) : `${port.port} → ${target}`;
}

export interface IngressRoute {
  host: string;
  path: string;
  pathType?: string;
  /** The backend Service, or a resource backend in words. */
  service?: string;
  port?: string;
  resource?: string;
}

const backendOf = (backend: any): Pick<IngressRoute, "service" | "port" | "resource"> => {
  if (backend?.service) {
    const port = backend.service.port?.number ?? backend.service.port?.name;
    return { service: backend.service.name, port: port !== undefined ? String(port) : undefined };
  }
  if (backend?.resource) return { resource: `${backend.resource.kind} ${backend.resource.name}` };
  return {};
};

/** Every host → path → backend of an Ingress; `*` for rules without a host. */
export function ingressRoutes(ingress: any): IngressRoute[] {
  const routes: IngressRoute[] = [];
  for (const rule of ingress?.spec?.rules ?? []) {
    const host = rule.host ?? "*";
    for (const path of rule.http?.paths ?? []) {
      routes.push({ host, path: path.path ?? "/", pathType: path.pathType, ...backendOf(path.backend) });
    }
  }
  if (ingress?.spec?.defaultBackend) {
    routes.push({ host: "*", path: "Everything else", ...backendOf(ingress.spec.defaultBackend) });
  }
  return routes;
}

/** Ingresses in the Service's namespace that send traffic to it. */
export function ingressesFor(service: any, ingresses: any[]): any[] {
  const name = service?.metadata?.name;
  const namespace = service?.metadata?.namespace;
  return ingresses.filter(
    (ingress) =>
      ingress?.metadata?.namespace === namespace && ingressRoutes(ingress).some((route) => route.service === name)
  );
}

/** HTTPRoutes (Gateway API) with a backend reference to the Service. */
export function httpRoutesFor(service: any, routes: any[]): any[] {
  const name = service?.metadata?.name;
  const namespace = service?.metadata?.namespace;
  return routes.filter((route) =>
    (route?.spec?.rules ?? []).some((rule: any) =>
      (rule.backendRefs ?? []).some(
        (ref: any) =>
          (ref.kind ?? "Service") === "Service" &&
          (ref.group ?? "") === "" &&
          ref.name === name &&
          (ref.namespace ?? route.metadata?.namespace) === namespace
      )
    )
  );
}
