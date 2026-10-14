/*
 * Gateway API: gateway and route states in words, listeners as
 * "HTTPS:443 *.acme.dev", and route rules as a calm flow
 * (match → backends with weights). Pure, unit tested.
 */
import { conditionOf, isFalse, isTrue, humanize, type OperatorState } from "./format";

export const GATEWAY_GROUP = "gateway.networking.k8s.io";

/* ----------------------------------------------------------- gateways -- */

export function gatewayState(gateway: any): OperatorState {
  const accepted = conditionOf(gateway, "Accepted");
  const programmed = conditionOf(gateway, "Programmed");
  if (isFalse(accepted)) {
    return { label: "Not accepted", tone: "destructive", reason: accepted!.reason, message: accepted!.message };
  }
  if (isFalse(programmed)) {
    return {
      label: "Not programmed",
      tone: "warning",
      reason: programmed!.reason,
      message: programmed!.message,
    };
  }
  if (isTrue(programmed)) return { label: "Programmed", tone: "success" };
  if (isTrue(accepted)) return { label: "Accepted", tone: "info", busy: true, message: programmed?.message };
  return { label: "Pending", tone: "muted" };
}

export interface Listener {
  name: string;
  /** "HTTPS:443". */
  endpoint: string;
  hostname?: string;
  attachedRoutes?: number;
  tls?: string;
  /** A listener condition that is not fine, in words. */
  problem?: string;
}

export function gatewayListeners(gateway: any): Listener[] {
  const statuses: any[] = gateway?.status?.listeners ?? [];
  return (gateway?.spec?.listeners ?? []).map((listener: any) => {
    const status = statuses.find((s) => s?.name === listener.name);
    const bad = (status?.conditions ?? []).find(
      (c: any) =>
        (c.type === "Accepted" || c.type === "Programmed" || c.type === "ResolvedRefs") &&
        c.status === "False"
    );
    const certs = (listener.tls?.certificateRefs ?? []).map((ref: any) => ref?.name).filter(Boolean);
    return {
      name: listener.name,
      endpoint: `${listener.protocol}:${listener.port}`,
      hostname: listener.hostname || undefined,
      attachedRoutes: status?.attachedRoutes,
      tls: certs.length ? certs.join(", ") : undefined,
      problem: bad ? `${humanize(bad.reason)}${bad.message ? `: ${bad.message}` : ""}` : undefined,
    };
  });
}

/** Distinct endpoints, e.g. "HTTP:80, HTTPS:443". */
export function listenersInWords(gateway: any): string {
  return [...new Set(gatewayListeners(gateway).map((l) => l.endpoint))].join(", ");
}

export const gatewayAddresses = (gateway: any): string[] =>
  (gateway?.status?.addresses ?? []).map((a: any) => a?.value).filter(Boolean);

export const attachedRoutes = (gateway: any): number =>
  (gateway?.status?.listeners ?? []).reduce(
    (sum: number, listener: any) => sum + (Number(listener?.attachedRoutes) || 0),
    0
  );

export function gatewayClassState(gatewayClass: any): OperatorState {
  const accepted = conditionOf(gatewayClass, "Accepted");
  if (isTrue(accepted)) return { label: "Accepted", tone: "success" };
  if (isFalse(accepted)) {
    return { label: "Not accepted", tone: "destructive", reason: accepted!.reason, message: accepted!.message };
  }
  return { label: "Pending", tone: "muted" };
}

/* ------------------------------------------------------------- routes -- */

export interface ParentStatus {
  /** "public-gateway", "platform/public-gateway", "public-gateway › https". */
  label: string;
  name: string;
  namespace?: string;
  kind: string;
  sectionName?: string;
  state: OperatorState;
}

const sameParent = (ref: any, other: any, routeNamespace?: string) =>
  ref?.name === other?.name &&
  (ref?.namespace ?? routeNamespace) === (other?.namespace ?? routeNamespace) &&
  (ref?.sectionName ?? "") === (other?.sectionName ?? "") &&
  (ref?.kind ?? "Gateway") === (other?.kind ?? "Gateway");

/** Each parent with its state: accepted, and with every backend resolved. */
export function routeParents(route: any): ParentStatus[] {
  const namespace = route?.metadata?.namespace;
  const statuses: any[] = route?.status?.parents ?? [];
  return (route?.spec?.parentRefs ?? []).map((ref: any): ParentStatus => {
    const status = statuses.find((s) => sameParent(s?.parentRef, ref, namespace));
    const accepted = (status?.conditions ?? []).find((c: any) => c.type === "Accepted");
    const resolved = (status?.conditions ?? []).find((c: any) => c.type === "ResolvedRefs");
    let state: OperatorState;
    if (!status || !accepted) state = { label: "Pending", tone: "muted" };
    else if (accepted.status === "False") {
      state = { label: "Not accepted", tone: "destructive", reason: accepted.reason, message: accepted.message };
    } else if (resolved?.status === "False") {
      state = {
        label: "Backend missing",
        tone: "warning",
        reason: resolved.reason,
        message: resolved.message,
      };
    } else state = { label: "Accepted", tone: "success" };

    const name = ref?.name ?? "";
    const qualified = ref?.namespace && ref.namespace !== namespace ? `${ref.namespace}/${name}` : name;
    return {
      label: ref?.sectionName ? `${qualified} › ${ref.sectionName}` : qualified,
      name,
      namespace: ref?.namespace ?? namespace,
      kind: ref?.kind ?? "Gateway",
      sectionName: ref?.sectionName,
      state,
    };
  });
}

/**
 * Routes attached to a gateway, each with its state there; problems first,
 * then by name.
 */
export function routesOfGateway(gateway: any, routes: any[]): { route: any; parent: ParentStatus }[] {
  const name = gateway?.metadata?.name;
  const namespace = gateway?.metadata?.namespace;
  const rank = (parent: ParentStatus) =>
    ({ destructive: 0, warning: 1, muted: 2 } as Record<string, number>)[parent.state.tone] ?? 3;
  return routes
    .flatMap((route) => {
      const parent = routeParents(route).find(
        (p) => p.kind === "Gateway" && p.name === name && p.namespace === namespace
      );
      return parent ? [{ route, parent }] : [];
    })
    .sort(
      (a, b) =>
        rank(a.parent) - rank(b.parent) ||
        String(a.route.metadata?.name).localeCompare(String(b.route.metadata?.name))
    );
}

/** The route's state: its worst parent. */
export function routeState(route: any): OperatorState {
  const parents = routeParents(route);
  if (parents.length === 0) return { label: "No parent", tone: "muted" };
  const worst =
    parents.find((p) => p.state.tone === "destructive") ??
    parents.find((p) => p.state.tone === "warning") ??
    parents.find((p) => p.state.tone === "muted");
  if (!worst) return { label: "Accepted", tone: "success" };
  if (worst.state.tone === "muted") return { label: "Pending", tone: "muted" };
  return {
    ...worst.state,
    message: parents.length > 1 ? `${worst.label}: ${worst.state.message ?? worst.state.label}` : worst.state.message,
  };
}

export interface Backend {
  /** "checkout-api:8080". */
  label: string;
  name: string;
  namespace?: string;
  kind: string;
  port?: number;
  weight: number;
  /** Share of the rule's traffic in percent (when split). */
  percent?: number;
}

export interface MatchLine {
  /** HTTP method ("GET"), when the match has one. */
  method?: string;
  /** "/api/*", "Any path", "acme.Payments/Charge". */
  target: string;
  /** Headers and query parameters: "x-env = canary", "?debug=1". */
  extras: string[];
}

/** "GET /api/* · x-env = canary". */
export const matchInWords = (match: MatchLine) =>
  [[match.method, match.target].filter(Boolean).join(" "), ...match.extras].join(" · ");

export interface RuleFlow {
  matches: MatchLine[];
  /** Filters in words: "Redirect to https", "Rewrite path to /". */
  filters: string[];
  backends: Backend[];
}

function pathInWords(path: any): string {
  const value = path?.value ?? "/";
  switch (path?.type ?? "PathPrefix") {
    case "Exact":
      return value;
    case "RegularExpression":
      return `~ ${value}`;
    default:
      return value === "/" ? "Any path" : `${value.replace(/\/$/, "")}/*`;
  }
}

function headerInWords(header: any): string {
  const op = header?.type === "RegularExpression" ? "~" : "=";
  return `${header?.name} ${op} ${header?.value}`;
}

function httpMatch(match: any): MatchLine {
  return {
    ...(match?.method ? { method: String(match.method) } : {}),
    target: pathInWords(match?.path),
    extras: [
      ...(match?.headers ?? []).map(headerInWords),
      ...(match?.queryParams ?? []).map((param: any) => `?${param?.name}=${param?.value}`),
    ],
  };
}

function grpcMatch(match: any): MatchLine {
  const method = match?.method ?? {};
  const target =
    method.service && method.method
      ? `${method.service}/${method.method}`
      : method.service
        ? `${method.service}/*`
        : method.method
          ? `*/${method.method}`
          : "Any method";
  return { target, extras: (match?.headers ?? []).map(headerInWords) };
}

function filterInWords(filter: any): string | null {
  switch (filter?.type) {
    case "RequestRedirect": {
      const redirect = filter.requestRedirect ?? {};
      const target = [
        redirect.scheme && `${redirect.scheme}://`,
        redirect.hostname,
        redirect.path?.replaceFullPath ?? redirect.path?.replacePrefixMatch,
      ]
        .filter(Boolean)
        .join("");
      return `Redirect${target ? ` to ${target}` : ""}${redirect.statusCode ? ` (${redirect.statusCode})` : ""}`;
    }
    case "URLRewrite": {
      const rewrite = filter.urlRewrite ?? {};
      const path = rewrite.path?.replaceFullPath ?? rewrite.path?.replacePrefixMatch;
      if (path && rewrite.hostname) return `Rewrite to ${rewrite.hostname}${path}`;
      if (path) return `Rewrite path to ${path}`;
      return rewrite.hostname ? `Rewrite host to ${rewrite.hostname}` : "Rewrite";
    }
    case "RequestHeaderModifier":
      return "Change request headers";
    case "ResponseHeaderModifier":
      return "Change response headers";
    case "RequestMirror":
      return `Mirror to ${filter.requestMirror?.backendRef?.name ?? "a backend"}`;
    default:
      return filter?.type ? humanize(filter.type) : null;
  }
}

/** The rules of an HTTPRoute or GRPCRoute as flows. */
export function routeRules(route: any): RuleFlow[] {
  const grpc = route?.kind === "GRPCRoute";
  const namespace = route?.metadata?.namespace;
  return (route?.spec?.rules ?? []).map((rule: any): RuleFlow => {
    const matches: any[] = rule?.matches ?? [];
    const refs: any[] = rule?.backendRefs ?? [];
    const weights = refs.map((ref) => (ref?.weight === undefined ? 1 : Number(ref.weight) || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    return {
      matches: matches.length
        ? matches.map(grpc ? grpcMatch : httpMatch)
        : [{ target: grpc ? "Any method" : "Any path", extras: [] }],
      filters: (rule?.filters ?? []).map(filterInWords).filter(Boolean) as string[],
      backends: refs.map((ref, index): Backend => {
        const kind = ref?.kind ?? "Service";
        const port = ref?.port !== undefined ? Number(ref.port) : undefined;
        return {
          label: port !== undefined ? `${ref?.name}:${port}` : String(ref?.name ?? ""),
          name: ref?.name ?? "",
          namespace: ref?.namespace ?? namespace,
          kind,
          port,
          weight: weights[index],
          ...(refs.length > 1 && total > 0
            ? { percent: Math.round((weights[index] / total) * 100) }
            : {}),
        };
      }),
    };
  });
}

/** Distinct backend names of a route, for tables. */
export const routeBackendNames = (route: any): string[] => [
  ...new Set(routeRules(route).flatMap((rule) => rule.backends.map((b) => b.name)).filter(Boolean)),
];
