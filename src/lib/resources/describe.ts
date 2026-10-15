/*
 * The native describe (pure, unit tested): an object, its events and what
 * is known around it (owners, a node's pods, a Service's endpoints) as a
 * structured document: its state, key facts per kind, conditions, events,
 * related objects (as references), labels and annotations. No kubectl
 * needed. `describeText` renders it as plain text for copying.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import { formatBytes, formatCores } from "@/lib/metrics/units";
import { parseMemory } from "@/components/tables/metrics";
import { hpaConditionWords, hpaMetrics } from "./autoscaling";
import { describeCron, nextCronRun } from "./cron";
import { ago, between, fromNow, plural, toMs } from "./format";
import { sizeWords } from "./highlight";
import type { ObjectRef } from "./kinds";
import { ingressRoutes, portMapping, serviceEndpoints } from "./network";
import { nodeAllocation, nodeHealth, nodePlacement, nodeRoles } from "./node";
import { QOS_WORDS, containerProbes, podState, podUses, schedulingWords } from "./pod";
import { objectState, type ObjectState } from "./state";
import { RECLAIM_WORDS, BINDING_WORDS, accessModeWords, isDefaultClass, volumeSource } from "./storage";

export interface DescribeValue {
  text: string;
  ref?: ObjectRef;
  mono?: boolean;
  muted?: boolean;
  tone?: StatusTone;
}

export interface DescribeRow {
  label: string;
  values: DescribeValue[];
  /** Between the values: " · " by default, " › " for a chain. */
  separator?: string;
}

export interface DescribeTable {
  columns: string[];
  rows: DescribeValue[][];
}

export interface DescribeSection {
  title: string;
  rows?: DescribeRow[];
  table?: DescribeTable;
  /** Shown when the section has nothing (e.g. "No events"). */
  empty?: string;
}

export interface DescribeDoc {
  kind: string;
  name: string;
  namespace?: string;
  state: ObjectState | null;
  sections: DescribeSection[];
}

export interface DescribeContext {
  now: number;
  events?: any[];
  /** Owners, nearest first (see resolveOwners). */
  owners?: ObjectRef[];
  /** A node's pods. */
  pods?: any[];
  /** A Service's EndpointSlices. */
  slices?: any[];
}

/* ---------------------------------------------------------- helpers -- */

const v = (text: unknown, extra: Omit<DescribeValue, "text"> = {}): DescribeValue => ({
  text: text === undefined || text === null || text === "" ? "–" : String(text),
  ...(text === undefined || text === null || text === "" ? { muted: true } : {}),
  ...extra,
});
const row = (label: string, ...values: DescribeValue[]): DescribeRow => ({ label, values });
const link = (ref: ObjectRef, text = ref.name): DescribeValue => ({ text, ref });
const when = (value: unknown, now: number) => {
  const ms = toMs(value);
  return ms === null ? "–" : `${ago(ms, now)} · ${new Date(ms).toLocaleString()}`;
};
const size = (value: unknown) => (value ? formatBytes(parseMemory(value)) : "–");

/** Long annotation / data values are cut (with their size) to keep the document readable. */
const cut = (text: string, limit = 240) =>
  text.length > limit ? `${text.slice(0, limit).replace(/\s+/g, " ")}… (${sizeWords(text)})` : text;

function conditionsSection(object: any, now: number): DescribeSection | null {
  const conditions: any[] = object?.status?.conditions ?? [];
  if (!conditions.length) return null;
  return {
    title: "Conditions",
    table: {
      columns: ["Type", "Status", "Reason", "Since", "Message"],
      rows: conditions.map((c) => [
        v(c.type),
        v(c.status),
        v(c.reason),
        v(c.lastTransitionTime ? ago(c.lastTransitionTime, now) : ""),
        v(c.message),
      ]),
    },
  };
}

function eventsSection(events: any[] | undefined, now: number): DescribeSection {
  return {
    title: "Events",
    empty: "No recent events. Kubernetes keeps them for about an hour.",
    table: {
      columns: ["Type", "Reason", "Last seen", "Count", "From", "Message"],
      rows: (events ?? []).map((e) => [
        v(e.type, { tone: e.type === "Warning" ? "warning" : undefined }),
        v(e.reason),
        v(ago(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp, now)),
        v(e.count ?? 1),
        v(e.source?.component ?? e.reportingComponent),
        v(e.message ?? e.note),
      ]),
    },
  };
}

function metadataSection(title: string, entries: Record<string, string> | undefined, mono = true): DescribeSection {
  const list = Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return {
    title,
    empty: `No ${title.toLowerCase()}`,
    rows: list.map(([key, value]) => row(key, v(cut(value), { mono }))),
  };
}

/* ------------------------------------------------------------ kinds -- */

function podSections(pod: any, ctx: DescribeContext): { facts: DescribeRow[]; sections: DescribeSection[] } {
  const spec = pod.spec ?? {};
  const status = pod.status ?? {};
  const ns = pod.metadata?.namespace;
  const facts = [
    row("Node", spec.nodeName ? link({ kind: "Node", name: spec.nodeName }) : v("Not scheduled yet", { muted: true })),
    row("IP", v((status.podIPs ?? []).map((ip: any) => ip.ip).join(", ") || status.podIP, { mono: true })),
    row("Host IP", v(status.hostIP, { mono: true })),
    row("Service account", spec.serviceAccountName ? link({ kind: "ServiceAccount", name: spec.serviceAccountName, namespace: ns }) : v("")),
    row("QoS class", v(status.qosClass), ...(QOS_WORDS[status.qosClass] ? [v(QOS_WORDS[status.qosClass], { muted: true })] : [])),
    row("Restart policy", v(spec.restartPolicy ?? "Always")),
    row("Started", v(when(status.startTime, ctx.now))),
  ];
  const statuses: any[] = [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])];
  const containers = [
    ...(spec.initContainers ?? []).map((c: any) => ({ c, init: true })),
    ...(spec.containers ?? []).map((c: any) => ({ c, init: false })),
  ];
  const sections: DescribeSection[] = containers.map(({ c, init }) => {
    const s = statuses.find((x) => x.name === c.name);
    const state = s?.state?.running
      ? `Running since ${ago(s.state.running.startedAt, ctx.now)}`
      : s?.state?.waiting
        ? `Waiting: ${s.state.waiting.reason ?? ""}${s.state.waiting.message ? ` (${s.state.waiting.message})` : ""}`
        : s?.state?.terminated
          ? `Terminated: ${s.state.terminated.reason ?? ""}, exit code ${s.state.terminated.exitCode}`
          : "Not started";
    const last = s?.lastState?.terminated;
    const pair = (resource: "cpu" | "memory") => {
      const request = c.resources?.requests?.[resource];
      const limit = c.resources?.limits?.[resource];
      return request || limit ? `${request ?? "–"} requested, ${limit ?? "no"} limit` : "";
    };
    const rows = [
      row("Image", v(c.image, { mono: true })),
      row("State", v(state, { tone: s?.state?.waiting || (s?.state?.terminated && s.state.terminated.exitCode !== 0) ? "warning" : undefined })),
      row("Ready", v(s ? (s.ready ? "Yes" : "No") : "")),
      row("Restarts", v(s?.restartCount ?? 0, { tone: (s?.restartCount ?? 0) > 0 ? "warning" : undefined })),
      ...(last ? [row("Last exit", v(`${last.reason ?? "Exited"}, code ${last.exitCode}, ${ago(last.finishedAt, ctx.now)}`))] : []),
      ...(c.ports?.length ? [row("Ports", v(c.ports.map((p: any) => `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`).join(", "), { mono: true }))] : []),
      ...(pair("cpu") ? [row("CPU", v(pair("cpu")))] : []),
      ...(pair("memory") ? [row("Memory", v(pair("memory")))] : []),
      ...containerProbes(c).map((p) => row(p.type, v(`${p.check}. ${p.timing}.`))),
      ...(c.volumeMounts ?? []).map((m: any) => row("Mount", v(`${m.mountPath} from ${m.name}${m.readOnly ? " (read-only)" : ""}`, { mono: true }))),
    ];
    return { title: `${init ? "Init container" : "Container"} ${c.name}`, rows };
  });
  const uses = podUses(pod);
  if (uses.length) {
    sections.push({
      title: "Config & storage",
      rows: uses.map((use) =>
        row(use.ref ? use.kind : "Volume", use.ref ? link(use.ref) : v(use.title), ...use.how.map((how) => v(how, { muted: true })))
      ),
    });
  }
  const scheduling = schedulingWords(spec);
  sections.push({
    title: "Scheduling",
    empty: "No constraints: any node with room.",
    rows: [
      ...scheduling.rules.map((rule) => row("Rule", v(rule))),
      ...scheduling.tolerations.map((t) => row("Toleration", v(t.replace(/^Tolerates /, "")))),
    ],
  });
  return { facts, sections };
}

function workloadFacts(object: any): DescribeRow[] {
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const kind = object.kind;
  const selector = [
    ...Object.entries(spec.selector?.matchLabels ?? {}).map(([k, val]) => `${k}=${val}`),
    ...(spec.selector?.matchExpressions ?? []).map((e: any) => `${e.key} ${e.operator} ${(e.values ?? []).join(",")}`),
  ].join(", ");
  const rows: DescribeRow[] = [];
  if (kind === "DaemonSet") {
    rows.push(row("Pods", v(`${status.numberReady ?? 0} ready of ${plural(status.desiredNumberScheduled ?? 0, "node")}, ${status.updatedNumberScheduled ?? 0} updated`)));
  } else {
    const desired = spec.replicas ?? 1;
    rows.push(
      row(
        "Replicas",
        v(`${status.readyReplicas ?? 0} ready of ${desired}${status.updatedReplicas !== undefined ? `, ${status.updatedReplicas} updated` : ""}${status.unavailableReplicas ? `, ${status.unavailableReplicas} unavailable` : ""}`, {
          tone: (status.readyReplicas ?? 0) < desired ? "warning" : undefined,
        })
      )
    );
  }
  rows.push(row("Selector", v(selector, { mono: true })));
  if (kind === "Deployment") {
    const strategy = spec.strategy ?? {};
    rows.push(
      row(
        "Strategy",
        v(
          strategy.type === "Recreate"
            ? "Recreate: old pods stop before new ones start"
            : `Rolling update: at most ${strategy.rollingUpdate?.maxUnavailable ?? "25%"} unavailable, ${strategy.rollingUpdate?.maxSurge ?? "25%"} extra`
        )
      )
    );
  }
  if (kind === "StatefulSet" && spec.serviceName) {
    rows.push(row("Service", link({ kind: "Service", name: spec.serviceName, namespace: object.metadata?.namespace })));
  }
  const revision = object.metadata?.annotations?.["deployment.kubernetes.io/revision"];
  if (revision) rows.push(row("Revision", v(revision)));
  const images = (spec.template?.spec?.containers ?? []).map((c: any) => `${c.name}: ${c.image}`);
  if (images.length) rows.push(row("Images", ...images.map((image: string) => v(image, { mono: true }))));
  return rows;
}

function kindSections(object: any, ctx: DescribeContext): { facts: DescribeRow[]; sections: DescribeSection[] } {
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const ns = object.metadata?.namespace;
  const now = ctx.now;
  switch (object.kind) {
    case "Pod":
      return podSections(object, ctx);
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
      return { facts: workloadFacts(object), sections: [] };
    case "Node": {
      const placement = nodePlacement(object.metadata?.labels);
      const health = nodeHealth(object);
      const info = status.nodeInfo ?? {};
      const facts = [
        row("Roles", v(nodeRoles(object.metadata?.labels).join(", "))),
        row("Scheduling", v(spec.unschedulable ? "Cordoned: no new pods" : "Takes new pods", { tone: spec.unschedulable ? "warning" : undefined })),
        row("Health", v(health.problems.length ? health.problems.map((p) => p.label).join(", ") : "No memory, disk or process pressure", { tone: health.problems.length ? "warning" : undefined })),
        row("Zone", v([placement.zone, placement.region].filter(Boolean).join(" · "))),
        row("Instance", v([placement.instanceType, placement.capacityType, placement.pool].filter(Boolean).join(" · "))),
        ...(status.addresses ?? [])
          .filter((a: any) => a.address !== object.metadata?.name)
          .map((a: any) => row(a.type.replace(/([a-z])([A-Z])/, "$1 $2"), v(a.address, { mono: true }))),
      ];
      const sections: DescribeSection[] = [
        {
          title: "Taints",
          empty: "No taints: any pod may be scheduled here.",
          rows: (spec.taints ?? []).map((t: any) => row(t.effect, v(`${t.key}${t.value ? `=${t.value}` : ""}`, { mono: true }))),
        },
      ];
      if (ctx.pods) {
        const a = nodeAllocation(object, ctx.pods);
        sections.push({
          title: "Requested",
          table: {
            columns: ["Resource", "Requested", "Limits", "Allocatable", "Capacity"],
            rows: [
              [v("CPU"), v(formatCores(a.cpu.requested)), v(formatCores(a.cpu.limits)), v(formatCores(a.cpu.allocatable)), v(formatCores(a.cpu.capacity))],
              [v("Memory"), v(formatBytes(a.memory.requested)), v(formatBytes(a.memory.limits)), v(formatBytes(a.memory.allocatable)), v(formatBytes(a.memory.capacity))],
              [v("Pods"), v(a.pods.requested), v(""), v(a.pods.allocatable), v(a.pods.capacity)],
            ],
          },
        });
        const onNode = ctx.pods.filter((p) => p.spec?.nodeName === object.metadata?.name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
        sections.push({
          title: `Pods (${onNode.length})`,
          empty: "No pods run here.",
          table: {
            columns: ["Namespace", "Pod", "State"],
            rows: onNode
              .sort((x, y) => `${x.metadata?.namespace}/${x.metadata?.name}`.localeCompare(`${y.metadata?.namespace}/${y.metadata?.name}`))
              .map((p) => {
                const state = podState(p, now);
                return [
                  v(p.metadata?.namespace),
                  link({ kind: "Pod", name: p.metadata?.name, namespace: p.metadata?.namespace }),
                  v(state.label, { tone: state.tone === "destructive" || state.tone === "warning" ? state.tone : undefined }),
                ];
              }),
          },
        });
      }
      sections.push({
        title: "System",
        rows: [
          row("OS", v(info.osImage)),
          row("Kernel", v(info.kernelVersion, { mono: true })),
          row("Runtime", v(info.containerRuntimeVersion, { mono: true })),
          row("Kubelet", v(info.kubeletVersion, { mono: true })),
          row("Architecture", v(info.architecture)),
          ...(spec.providerID ? [row("Provider ID", v(spec.providerID, { mono: true }))] : []),
        ],
      });
      return { facts, sections };
    }
    case "Service": {
      const external = (status.loadBalancer?.ingress ?? []).map((i: any) => i.hostname ?? i.ip);
      const facts = [
        row("Type", v(spec.clusterIP === "None" ? "Headless" : (spec.type ?? "ClusterIP"))),
        row("Cluster IP", v(spec.clusterIP === "None" ? "" : spec.clusterIP, { mono: true })),
        ...(spec.type === "LoadBalancer" || external.length ? [row("External", v(external.join(", ") || "Waiting for an address", { mono: !!external.length, tone: external.length ? undefined : "warning" }))] : []),
        ...(spec.externalName ? [row("Points to", v(spec.externalName, { mono: true }))] : []),
        row("Selector", v(Object.entries(spec.selector ?? {}).map(([k, val]) => `${k}=${val}`).join(", ") || "None", { mono: true })),
        ...(spec.sessionAffinity === "ClientIP" ? [row("Session affinity", v("Client IP"))] : []),
      ];
      const sections: DescribeSection[] = [
        {
          title: "Ports",
          empty: "No ports.",
          table: {
            columns: ["Name", "Port", "Protocol", "Node port"],
            rows: (spec.ports ?? []).map((p: any) => [v(p.name), v(portMapping(p), { mono: true }), v(p.protocol ?? "TCP"), v(p.nodePort)]),
          },
        },
      ];
      if (ctx.slices) {
        const endpoints = serviceEndpoints(object, ctx.slices);
        sections.push({
          title: `Endpoints (${endpoints.filter((e) => e.ready).length} ready of ${endpoints.length})`,
          empty: Object.keys(spec.selector ?? {}).length ? "No pods match the selector." : "No endpoints.",
          table: {
            columns: ["Address", "Pod", "Ready", "Node"],
            rows: endpoints.map((e) => [
              v(e.addresses.join(", "), { mono: true }),
              e.targetRef?.kind === "Pod" && e.targetRef.name ? link({ kind: "Pod", name: e.targetRef.name, namespace: e.targetRef.namespace ?? ns }) : v(""),
              v(e.ready ? "Yes" : e.terminating ? "Terminating" : "No", { tone: e.ready ? undefined : "warning" }),
              v(e.nodeName),
            ]),
          },
        });
      }
      return { facts, sections };
    }
    case "Ingress": {
      const facts = [
        row("Class", spec.ingressClassName ? link({ kind: "IngressClass", name: spec.ingressClassName }) : v("The cluster's default", { muted: true })),
        row("Address", v((status.loadBalancer?.ingress ?? []).map((i: any) => i.hostname ?? i.ip).join(", ") || "None yet", { mono: true })),
      ];
      const sections: DescribeSection[] = [
        {
          title: "Rules",
          empty: "No rules.",
          table: {
            columns: ["Host", "Path", "Backend", "Port"],
            rows: ingressRoutes(object).map((r) => [
              v(r.host === "*" ? "Any host" : r.host),
              v(r.path, { mono: true }),
              r.service ? link({ kind: "Service", name: r.service, namespace: ns }) : v(r.resource),
              v(r.port),
            ]),
          },
        },
      ];
      if (spec.tls?.length) {
        sections.push({
          title: "TLS",
          rows: spec.tls.map((t: any) =>
            row((t.hosts ?? []).join(", ") || "Every host", t.secretName ? link({ kind: "Secret", name: t.secretName, namespace: ns }) : v("The controller's default certificate"))
          ),
        });
      }
      return { facts, sections };
    }
    case "PersistentVolumeClaim":
      return {
        facts: [
          row("Status", v(status.phase, { tone: status.phase === "Bound" ? undefined : "warning" })),
          row("Requested", v(size(spec.resources?.requests?.storage))),
          row("Bound", v(status.capacity?.storage ? size(status.capacity.storage) : "")),
          row("Storage class", spec.storageClassName ? link({ kind: "StorageClass", name: spec.storageClassName }) : v("The default", { muted: true })),
          row("Access", v(accessModeWords(spec.accessModes))),
          row("Volume", spec.volumeName ? link({ kind: "PersistentVolume", name: spec.volumeName }) : v("Not bound yet", { muted: true })),
        ],
        sections: [],
      };
    case "PersistentVolume": {
      const source = volumeSource(object);
      return {
        facts: [
          row("Status", v(status.phase)),
          row("Size", v(size(spec.capacity?.storage))),
          row("Claim", spec.claimRef?.name ? link({ kind: "PersistentVolumeClaim", name: spec.claimRef.name, namespace: spec.claimRef.namespace }, `${spec.claimRef.namespace}/${spec.claimRef.name}`) : v("Not claimed", { muted: true })),
          row("Storage class", spec.storageClassName ? link({ kind: "StorageClass", name: spec.storageClassName }) : v("")),
          row("Access", v(accessModeWords(spec.accessModes))),
          row("Reclaim policy", v(`${spec.persistentVolumeReclaimPolicy ?? "Retain"}: ${(RECLAIM_WORDS[spec.persistentVolumeReclaimPolicy ?? "Retain"] ?? "").toLowerCase()}`)),
          row("Stored in", v(source.kind), ...(source.detail ? [v(source.detail, { mono: true })] : [])),
        ],
        sections: [],
      };
    }
    case "StorageClass":
      return {
        facts: [
          row("Provisioner", v(object.provisioner, { mono: true })),
          row("Default", v(isDefaultClass(object) ? "Yes" : "No")),
          row("Binding", v(BINDING_WORDS[object.volumeBindingMode ?? "Immediate"] ?? object.volumeBindingMode)),
          row("Reclaim policy", v(object.reclaimPolicy ?? "Delete")),
          row("Volume expansion", v(object.allowVolumeExpansion ? "Allowed" : "Not allowed")),
        ],
        sections: [metadataSection("Parameters", object.parameters)],
      };
    case "HorizontalPodAutoscaler": {
      const target = spec.scaleTargetRef ?? {};
      return {
        facts: [
          row("Scales", link({ kind: target.kind, name: target.name, namespace: ns, apiVersion: target.apiVersion }, `${target.kind} ${target.name}`)),
          row("Replicas", v(`${status.currentReplicas ?? 0} now (between ${spec.minReplicas ?? 1} and ${spec.maxReplicas})${status.desiredReplicas !== status.currentReplicas ? `, heading to ${status.desiredReplicas}` : ""}`)),
          ...(status.lastScaleTime ? [row("Last scaled", v(when(status.lastScaleTime, now)))] : []),
        ],
        sections: [
          {
            title: "Metrics",
            empty: "No metrics.",
            table: {
              columns: ["Metric", "Current", "Target", "Measured"],
              rows: hpaMetrics(object).map((m) => [v(m.label), v(m.currentText), v(m.targetText), v(m.scope)]),
            },
          },
          {
            title: "Scaling",
            rows: hpaConditionWords(object).map((c) => row(c.text, v(c.message ?? "", { muted: c.ok, tone: c.ok ? undefined : "warning" }))),
          },
        ],
      };
    }
    case "Job":
      return {
        facts: [
          row("Completions", v(`${status.succeeded ?? 0} of ${spec.completions ?? 1}`)),
          row("Parallelism", v(spec.parallelism ?? 1)),
          row("Failed", v(status.failed ?? 0, { tone: status.failed ? "warning" : undefined })),
          row("Backoff limit", v(spec.backoffLimit ?? 6)),
          row("Started", v(when(status.startTime, now))),
          row("Duration", v(status.completionTime ? between(status.startTime, status.completionTime) : status.startTime ? `${between(status.startTime, now)} so far` : "")),
        ],
        sections: [],
      };
    case "CronJob": {
      const next = spec.suspend ? null : nextCronRun(spec.schedule ?? "", now, spec.timeZone || "UTC");
      return {
        facts: [
          row("Schedule", v(describeCron(spec.schedule ?? "") ?? "Custom schedule"), v(spec.schedule, { mono: true })),
          row("Time zone", v(spec.timeZone ?? "The controller's (usually UTC)")),
          row("Next run", v(spec.suspend ? "None: suspended" : next ? `${fromNow(next, now)} · ${new Date(next).toLocaleString()}` : "")),
          row("Last run", v(status.lastScheduleTime ? when(status.lastScheduleTime, now) : "")),
          row("Last success", v(status.lastSuccessfulTime ? when(status.lastSuccessfulTime, now) : "Not yet")),
          row("Overlap", v(spec.concurrencyPolicy ?? "Allow")),
          row("Suspended", v(spec.suspend ? "Yes" : "No")),
          row("Running jobs", ...((status.active ?? []).length ? status.active.map((j: any) => link({ kind: "Job", name: j.name, namespace: j.namespace ?? ns })) : [v("None", { muted: true })])),
        ],
        sections: [],
      };
    }
    case "ConfigMap":
      return {
        facts: [],
        sections: [
          {
            title: "Data",
            empty: "No data.",
            rows: [
              ...Object.entries(object.data ?? {}).map(([key, value]) => row(key, v(cut(String(value), 400), { mono: true }))),
              ...Object.keys(object.binaryData ?? {}).map((key) => row(key, v("Binary data", { muted: true }))),
            ],
          },
        ],
      };
    case "Secret":
      return {
        facts: [row("Type", v(object.type ?? "Opaque"))],
        sections: [
          {
            title: "Data",
            empty: "No data.",
            // Never the values: their sizes, like kubectl.
            rows: Object.entries(object.data ?? {}).map(([key, value]) =>
              row(key, v(`${Math.floor((String(value).replace(/=+$/, "").length * 3) / 4)} bytes`, { muted: true }))
            ),
          },
        ],
      };
    case "Namespace":
      return { facts: [row("Status", v(status.phase))], sections: [] };
    case "Event": {
      const involved = object.involvedObject ?? object.regarding ?? {};
      return {
        facts: [
          row("Type", v(object.type, { tone: object.type === "Warning" ? "warning" : undefined })),
          row("Reason", v(object.reason)),
          row("Message", v(object.message ?? object.note)),
          row("About", involved.name ? link({ kind: involved.kind, name: involved.name, namespace: involved.namespace, apiVersion: involved.apiVersion }, `${involved.kind} ${involved.name}`) : v("")),
          row("Count", v(object.count ?? 1)),
          row("First seen", v(when(object.firstTimestamp ?? object.eventTime, now))),
          row("Last seen", v(when(object.lastTimestamp ?? object.eventTime, now))),
          row("From", v([object.source?.component, object.source?.host].filter(Boolean).join(" on "))),
        ],
        sections: [],
      };
    }
    default:
      return { facts: [], sections: genericSections(object) };
  }
}

/* Other kinds (CRDs): spec and status as flattened fields. */
function flatten(value: unknown, path: string, rows: DescribeRow[], limit: number) {
  if (rows.length >= limit) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) rows.push(row(path, v("{}", { muted: true })));
    for (const [key, child] of entries) flatten(child, path ? `${path}.${key}` : key, rows, limit);
    return;
  }
  if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, rows, limit));
    return;
  }
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  rows.push(row(path, v(cut(text, 200), { mono: true })));
}

function genericSections(object: any): DescribeSection[] {
  const sections: DescribeSection[] = [];
  for (const key of ["spec", "status"] as const) {
    const value = key === "status" ? { ...object.status, conditions: undefined } : object[key];
    if (!value || typeof value !== "object") continue;
    const rows: DescribeRow[] = [];
    flatten(JSON.parse(JSON.stringify(value)), "", rows, 80);
    if (rows.length) sections.push({ title: key === "spec" ? "Spec" : "Status", rows });
  }
  return sections;
}

/* ------------------------------------------------------------ build -- */

export function describeObject(object: any, ctx: DescribeContext): DescribeDoc {
  const metadata = object?.metadata ?? {};
  const { facts, sections } = kindSections(object, ctx);
  const owners = ctx.owners ?? [];
  const overview: DescribeRow[] = [
    row("Name", v(metadata.name, { mono: true })),
    ...(metadata.namespace ? [row("Namespace", link({ kind: "Namespace", name: metadata.namespace }))] : []),
    row("Created", v(when(metadata.creationTimestamp, ctx.now))),
    ...(owners.length
      ? [{ ...row("Controlled by", ...[...owners].reverse().map((o) => link(o, `${o.kind} ${o.name}`))), separator: " › " }]
      : []),
    ...(metadata.deletionTimestamp ? [row("Deleting", v(when(metadata.deletionTimestamp, ctx.now), { tone: "warning" }))] : []),
    ...(metadata.finalizers?.length ? [row("Finalizers", ...metadata.finalizers.map((f: string) => v(f, { mono: true })))] : []),
    ...facts,
  ];
  const all: (DescribeSection | null)[] = [
    { title: "Overview", rows: overview },
    ...sections,
    object?.kind === "Event" ? null : conditionsSection(object, ctx.now),
    object?.kind === "Event" ? null : eventsSection(ctx.events, ctx.now),
    metadataSection("Labels", metadata.labels),
    metadataSection("Annotations", metadata.annotations),
  ];
  return {
    kind: object?.kind ?? "",
    name: metadata.name ?? "",
    namespace: metadata.namespace,
    state: objectState(object, ctx.now),
    sections: all.filter((s): s is DescribeSection => !!s),
  };
}

const valuesText = (r: DescribeRow) => r.values.map((value) => value.text).join(r.separator ?? " · ");

/** The document as aligned plain text, kubectl style. */
export function describeText(doc: DescribeDoc): string {
  const lines: string[] = [`${doc.kind} ${doc.namespace ? `${doc.namespace}/` : ""}${doc.name}`];
  if (doc.state) lines.push(`State: ${doc.state.label}${doc.state.detail ? `. ${doc.state.detail}` : ""}`);
  for (const section of doc.sections) {
    lines.push("", `${section.title}:`);
    if (section.rows?.length) {
      const width = Math.min(28, Math.max(...section.rows.map((r) => r.label.length)) + 2);
      for (const r of section.rows) lines.push(`  ${`${r.label}:`.padEnd(width)}${valuesText(r)}`);
    }
    if (section.table?.rows.length) {
      const columns = section.table.columns;
      const cells = section.table.rows.map((r) => r.map((c) => c.text));
      const widths = columns.map((c, i) => Math.min(48, Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length))) + 2);
      lines.push(`  ${columns.map((c, i) => (i < columns.length - 1 ? c.padEnd(widths[i]!) : c)).join("")}`);
      for (const r of cells) lines.push(`  ${r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]!) : c)).join("")}`);
    }
    if (!section.rows?.length && !section.table?.rows.length && section.empty) lines.push(`  ${section.empty}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Every searchable text of a document under a stable key, in reading
 * order (the order the view renders them): matches are numbered by it.
 */
export function describeStrings(doc: DescribeDoc): [string, string][] {
  const strings: [string, string][] = [];
  doc.sections.forEach((section, s) => {
    strings.push([`${s}.t`, section.title]);
    section.rows?.forEach((r, i) => {
      strings.push([`${s}.r${i}.l`, r.label]);
      r.values.forEach((value, j) => strings.push([`${s}.r${i}.v${j}`, value.text]));
    });
    // Tables without rows aren't rendered (the empty text is): nothing to find in them.
    if (section.table?.rows.length) {
      section.table.columns.forEach((c, i) => strings.push([`${s}.h${i}`, c]));
      section.table.rows.forEach((r, i) => r.forEach((cell, j) => strings.push([`${s}.c${i}.${j}`, cell.text])));
    }
  });
  return strings;
}

/** Case-insensitive match starts of `query` in `text`. */
export function matchStarts(text: string, query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const starts: number[] = [];
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    starts.push(from);
    from = haystack.indexOf(needle, from + needle.length);
  }
  return starts;
}
