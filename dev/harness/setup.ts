/*
 * Visual QA harness: runs the real app in a plain browser by mocking the
 * Tauri IPC layer (core commands + the plugins used at startup) with
 * fixture data. Loaded only by `npm run harness` (dev/harness/vite.config.ts),
 * never part of a production build.
 *
 * Knobs (query string on first load, persisted in localStorage):
 *   ?theme=dark|light        colour scheme
 *   ?os=linux|macos|windows  window chrome variant
 *   ?scenario=default|empty|error|nocontext|whatsnew|large|large-graph|conflict|compare
 *   ?contexts=2              activate both contexts
 *   ?polling=0|1             kubectl polling instead of live watches
 *                            (settings.experimental.useKubectlPolling)
 *   ?delay=<ms>              slow down settings + discovery (skeletons)
 *   ?themeId=<id>            app theme for both appearances
 *                            (settings.appearance.lightTheme/darkTheme;
 *                            `jet` is the default)
 *
 * `large` scales the first context to 5000 pods with a stream of live
 * changes (watch deltas) to exercise the list views; `large-graph` swaps the
 * first context for a 2,000+ object topology for the resource graph.
 * Editor scenarios: `conflict` bumps an object's resourceVersion after its
 * first fetch (stale-edit flow); `compare` activates a second context.
 *
 * Files the app writes (settings.json, discovery cache, user themes in
 * themes/, ...) live in sessionStorage, so a reload sees them (restored
 * tabs, workspaces). `?fresh=1` clears them. fs watchers get events for
 * writes and removals under the watched path. Open VSX (openvsx_search /
 * openvsx_install) answers from fixtures; installing `harness.gpl-theme`
 * fails the licence check.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import yaml from "js-yaml";
import {
  API_GROUPS,
  CLUSTERS,
  buildLargeCluster,
  CONTEXTS,
  CORE_RESOURCES,
  HOME,
  KUBECONFIG,
  NAMESPACES,
  OPENVSX_EXTENSIONS,
  describe,
  logLines,
  openVsxThemes,
} from "./fixtures";

const params = new URLSearchParams(location.search);
if (params.get("fresh")) {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("harness-fs:") || key === "harness-fs-dirs") sessionStorage.removeItem(key);
  }
  // The theme runtime's first-paint cache would repaint a removed theme.
  localStorage.removeItem("jet-theme-cache");
}
const delay = Number(params.get("delay") || 0);
for (const key of ["theme", "os", "scenario", "polling", "themeId"]) {
  const value = params.get(key);
  if (value) localStorage.setItem(`harness-${key}`, value);
}
const theme = localStorage.getItem("harness-theme") || "dark";
/* ?themeId=<id>: null when the knob was never used (settings decide). */
const themeId = localStorage.getItem("harness-themeId");
const os = localStorage.getItem("harness-os") || "linux";
const scenario = localStorage.getItem("harness-scenario") || "default";
const polling = localStorage.getItem("harness-polling") === "1";

/* ?scenario=large-graph swaps the first context for a 2,000+ object cluster. */
const clusters =
  scenario === "large-graph"
    ? { ...CLUSTERS, [CONTEXTS[0].name]: buildLargeCluster() }
    : CLUSTERS;
/* ?contexts=2 activates both contexts (multi-context mode). */
const multiContext = params.get("contexts") === "2";
/* ?lograte=N streams N log lines per second (log viewer perf testing). */
const LOG_RATE = Number(params.get("lograte") || 0);

// VueUse's useColorMode persists its own value; keep it in sync.
localStorage.setItem("vueuse-color-scheme", theme);

// Expose the (lazily loaded) Monaco API as window.monaco for shoot.mjs.
(self as any).MonacoEnvironment = { globalAPI: true };
document.documentElement.classList.toggle("dark", theme === "dark");

(window as any).__TAURI_OS_PLUGIN_INTERNALS__ = {
  os_type: os,
  platform: os === "macos" ? "macos" : os,
  family: os === "windows" ? "windows" : "unix",
  version: "1.0.0",
  arch: "x86_64",
  eol: "\n",
  exe_extension: "",
};

mockWindows("main");

const settings = {
  lastKubeConfig: KUBECONFIG,
  lastContext: scenario === "nocontext" ? null : CONTEXTS[0].name,
  lastNamespace: "",
  activeContexts:
    scenario === "nocontext"
      ? []
      : [
          { context: CONTEXTS[0].name, kubeConfig: KUBECONFIG, namespaces: ["all"] },
          ...(multiContext || scenario === "compare"
            ? [{ context: CONTEXTS[1].name, kubeConfig: KUBECONFIG, namespaces: ["all"] }]
            : []),
        ],
  PanelProvider: { height: 45 },
  shell: { executable: "/bin/bash" },
  logs: { tail_lines: 100 },
  kubeConfigs: [KUBECONFIG],
  contextSettings: [],
  collapsedNavigationGroups: ["Policies", "Access Control", "Scaling"],
  pinnedResources: [
    { name: "pods", kind: "Pod" },
    { name: "deployments", kind: "Deployment" },
    { name: "services", kind: "Service" },
  ],
  appearance: { colorScheme: theme, lightTheme: themeId || "jet", darkTheme: themeId || "jet" },
  updates: { checkOnStartup: false, whatsNew: scenario === "whatsnew" ? "1.0.0" : "1.35.0" },
  logLevel: "error",
  ...(polling ? { experimental: { useKubectlPolling: true } } : {}),
};

/* Synthetic large cluster: clones of the fixture pods with unique ids. */
const LARGE_POD_COUNT = 5000;
if (scenario === "large") {
  const cluster = CLUSTERS[CONTEXTS[0].name];
  const templates = cluster.pods;
  const metricTemplates = new Map(cluster.podmetrics.map((m) => [m.metadata.name, m]));
  const pods: any[] = [];
  const metrics: any[] = [];
  for (let i = 0; i < LARGE_POD_COUNT; i++) {
    const template = templates[i % templates.length];
    const name = `${template.metadata.name}-${i.toString(36)}`;
    pods.push({
      ...template,
      metadata: { ...template.metadata, name, uid: `large-${i}`, resourceVersion: "1" },
    });
    const metric = metricTemplates.get(template.metadata.name);
    if (metric) {
      metrics.push({ ...metric, metadata: { ...metric.metadata, name } });
    }
  }
  cluster.pods = pods;
  cluster.podmetrics = metrics;
}

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Channel messages: the mock's callbacks are keyed by channel id. */
const channelIndex = new Map<number, number>();
const sendToChannel = (channel: any, message: unknown) => {
  const id = channel.id as number;
  const index = channelIndex.get(id) ?? 0;
  channelIndex.set(id, index + 1);
  (window as any).__TAURI_INTERNALS__.runCallback(id, { index, message });
};

/*
 * Rollout history: every Deployment gets revision annotations and three
 * older (scaled down) ReplicaSets with earlier images / settings.
 */
for (const cluster of Object.values(CLUSTERS)) {
  const extra: any[] = [];
  for (const dep of cluster.deployments) {
    const rs = cluster.replicasets.find((r: any) => r.metadata.ownerReferences?.[0]?.uid === dep.metadata.uid);
    if (!rs) continue;
    const image = dep.spec.template.spec.containers[0].image as string;
    const [repo, tag] = image.split(":");
    rs.metadata.annotations = {
      "deployment.kubernetes.io/revision": "7",
      "kubernetes.io/change-cause": `helm upgrade ${dep.metadata.name} --set image.tag=${tag}`,
    };
    rs.spec.template = JSON.parse(JSON.stringify(dep.spec.template));
    rs.spec.template.metadata.labels["pod-template-hash"] = rs.metadata.name.split("-").pop();
    const older = [
      { revision: 6, tag: tag?.replace(/(\d+)$/, (n: string) => String(Math.max(0, Number(n) - 1))), cause: "kubectl set image", days: 2, env: "info" },
      { revision: 5, tag: tag?.replace(/(\d+)$/, (n: string) => String(Math.max(0, Number(n) - 2))), cause: "", days: 9, env: "debug" },
      { revision: 4, tag: "v1.9.0", cause: "Initial rollout", days: 30, env: "debug" },
    ];
    for (const o of older) {
      const template = JSON.parse(JSON.stringify(dep.spec.template));
      template.spec.containers[0].image = `${repo}:${o.tag}`;
      template.spec.containers[0].env = [{ name: "LOG_LEVEL", value: o.env }];
      if (o.revision === 4) delete template.spec.containers[0].resources?.limits;
      const name = `${dep.metadata.name}-${o.revision}b${o.days}f${o.revision}c`;
      template.metadata.labels = { ...template.metadata.labels, "pod-template-hash": name.split("-").pop() };
      extra.push({
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name,
          namespace: dep.metadata.namespace,
          uid: `${rs.metadata.uid}-${o.revision}`,
          creationTimestamp: new Date(Date.now() - o.days * 86400000).toISOString(),
          labels: rs.metadata.labels,
          annotations: {
            "deployment.kubernetes.io/revision": String(o.revision),
            ...(o.cause ? { "kubernetes.io/change-cause": o.cause } : {}),
          },
          ownerReferences: rs.metadata.ownerReferences,
        },
        spec: { replicas: 0, template },
        status: { replicas: 0 },
      });
    }
  }
  cluster.replicasets.push(...extra);
}

/* ---------------------------------------------------------------- kubectl */

/* Supports both `--flag value` and `--flag=value`. */
const argValue = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1];
  const joined = args.find((a) => a.startsWith(`${flag}=`));
  return joined ? joined.slice(flag.length + 1) : undefined;
};

const resourceKey = (resource: string) =>
  resource.split(".")[0].toLowerCase();

function kubectlGet(args: string[]): string {
  const context = argValue(args, "--context") || CONTEXTS[0].name;
  const namespace = argValue(args, "--namespace") || argValue(args, "-n");
  const cluster = clusters[context];
  const resource = args[1];

  if (scenario === "error" && resourceKey(resource) !== "podmetrics") {
    throw new Error(
      `Unable to connect to the server: dial tcp 10.0.12.34:443: i/o timeout (context ${context})`
    );
  }

  const key = resourceKey(resource);
  // One Secret by name (the graph inspector's "Load Secret").
  if (key === "secret" && args[2] && !args[2].startsWith("-")) {
    const secret = cluster.secrets.find(
      (s: any) => s.metadata?.name === args[2] && (!namespace || s.metadata?.namespace === namespace)
    );
    if (!secret) throw new Error(`Error from server (NotFound): secrets "${args[2]}" not found`);
    return JSON.stringify(secret);
  }
  // Every fixture list is keyed by its plural resource name.
  let items: any[] =
    scenario === "empty" && key !== "namespaces" ? [] : cluster[key] || [];

  if (namespace && !["nodes", "namespaces"].includes(key)) {
    items = items.filter((i) => i.metadata?.namespace === namespace);
  }

  if (args[0] === "events" && args.includes("--for")) {
    const [, name] = (argValue(args, "--for") || "").split("/");
    items = cluster.events.filter((e) => e.involvedObject.name === name);
    if (items.length === 0) items = cluster.events.slice(4, 7);
  }

  // The resource graph lists Secrets metadata-only (clusterGraphSources.ts).
  if (key === "secrets" && (argValue(args, "-o") || "").startsWith("jsonpath=")) {
    return items
      .map((s) =>
        [
          s.metadata?.uid,
          s.metadata?.namespace,
          s.metadata?.name,
          s.type,
          s.metadata?.resourceVersion,
          s.metadata?.creationTimestamp,
          s.metadata?.labels ? JSON.stringify(s.metadata.labels) : "",
          s.metadata?.annotations?.["meta.helm.sh/release-name"],
        ]
          .map((v) => v ?? "")
          .join("\t") + "\n"
      )
      .join("");
  }

  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

function findObject(context: string, typeName: string) {
  const [type, name] = typeName.split("/");
  const cluster = clusters[context] || clusters[CONTEXTS[0].name];
  const key = resourceKey(type.endsWith("s") ? type : `${type}s`);
  const list: any[] = (cluster as any)[key] || cluster.pods;
  return list.find((o) => o.metadata?.name === name) || list[0];
}

/* --------------------------------------------------------------- editor -- */

/* Object fetches per context/type/name, for the `conflict` scenario. */
const yamlFetches = new Map<string, number>();

function objectYaml(context: string, typeName: string): string {
  const obj = structuredClone(findObject(context, typeName));
  const key = `${context}/${typeName}`;
  const count = (yamlFetches.get(key) || 0) + 1;
  yamlFetches.set(key, count);
  if (obj.metadata) {
    delete obj.metadata.context;
    delete obj.metadata.kubeConfig;
    obj.metadata.resourceVersion = "48213";
  }
  delete obj.metrics;
  if (scenario === "conflict" && count > 1 && obj.metadata) {
    // Someone else rolled out a new image meanwhile.
    obj.metadata.resourceVersion = "48290";
    const containers = obj.spec?.template?.spec?.containers || obj.spec?.containers;
    if (containers?.[0]) containers[0].image = containers[0].image.replace(/:[^:]+$/, ":v2.15.0");
  }
  return yaml.dump(obj, { lineWidth: 120, noArrayIndent: true });
}

/* Cluster OpenAPI v3 documents: the upstream published specs. */
const openapiCache = new Map<string, Promise<ArrayBuffer>>();
function openapiDocument(apiVersion: string): Promise<ArrayBuffer> {
  const file = apiVersion.includes("/")
    ? `apis__${apiVersion.replace("/", "__")}_openapi.json`
    : `api__${apiVersion}_openapi.json`;
  let doc = openapiCache.get(file);
  if (!doc) {
    doc = fetch(
      `https://raw.githubusercontent.com/kubernetes/kubernetes/v1.33.0/api/openapi-spec/v3/${file}`
    ).then((r) => {
      if (!r.ok) throw { message: `The cluster publishes no OpenAPI v3 schema for ${apiVersion}`, reason: "NotFound" };
      return r.arrayBuffer();
    });
    openapiCache.set(file, doc);
  }
  return doc;
}

const CONTAINER_FIELDS = new Set(
  "name image imagePullPolicy command args workingDir ports envFrom env resources resizePolicy restartPolicy volumeMounts volumeDevices livenessProbe readinessProbe startupProbe lifecycle terminationMessagePath terminationMessagePolicy securityContext stdin stdinOnce tty".split(" ")
);

/* A small stand-in for the API server's validation + admission. */
function applyManifest(p: any): string {
  const obj: any = yaml.load(p.manifest);
  const kind = obj?.kind || "Object";
  const name = obj?.metadata?.name || "unknown";
  const verb = p.mode === "apply" ? "creating" : "replacing";
  const unknown: string[] = [];
  const podSpec = kind === "Pod" ? obj.spec : obj?.spec?.template?.spec;
  const specPath = kind === "Pod" ? "spec" : "spec.template.spec";
  (podSpec?.containers || []).forEach((c: any, i: number) => {
    for (const k of Object.keys(c || {})) {
      if (!CONTAINER_FIELDS.has(k)) unknown.push(`unknown field "${specPath}.containers[${i}].${k}"`);
    }
  });
  if (unknown.length) {
    throw `Error from server (BadRequest): error when ${verb} "STDIN": ${kind} in version "v1" cannot be handled as a ${kind}: strict decoding error: ${unknown.join(", ")}`;
  }
  const invalid: string[] = [];
  if (typeof obj?.spec?.replicas === "number" && obj.spec.replicas < 0) {
    invalid.push(`spec.replicas: Invalid value: ${obj.spec.replicas}: must be greater than or equal to 0`);
  }
  (podSpec?.containers || []).forEach((c: any, i: number) => {
    if (!c?.image) invalid.push(`${specPath}.containers[${i}].image: Required value`);
  });
  if (invalid.length) {
    throw `The ${kind} "${name}" is invalid: ${invalid.length > 1 ? `[${invalid.join(", ")}]` : invalid[0]}`;
  }
  const result = `${kind.toLowerCase()}/${name} ${p.mode === "apply" ? "created" : "replaced"}`;
  return p.dryRun ? `${result} (server dry run)\n` : `${result}\n`;
}

/* ------------------------------------------------------ structured logs -- */

interface LogEntry {
  id: string;
  seq: number;
  content: string;
  timestamp: string;
  data: any;
  pod: string | null;
  container: string | null;
}
interface LogSession {
  entries: LogEntry[];
  nextSeq: number;
  facets: Map<string, { match_type: "AND" | "OR"; filtered: Set<string> }>;
  columns: Set<string>;
  stream?: ReturnType<typeof setInterval>;
  generation: number;
}
const sessions = new Map<string, LogSession>();
let sessionCounter = 0;

/* Facet keys are JSON-serialized values, like the backend's. */
const facetKey = (entry: LogEntry, property: string) => {
  const value =
    property === "@pod" ? entry.pod ?? undefined : property === "@container" ? entry.container ?? undefined : entry.data?.[property];
  return value === undefined ? undefined : JSON.stringify(value);
};

/* Backend timestamps carry exactly 9 fractional digits. */
const nanoTimestamp = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");

function addLogData(session: LogSession, data: string) {
  let columnsChanged = false;
  for (const raw of data.split("\n")) {
    if (!raw.trim()) continue;
    const prefix = /^\[pod\/([^/]+)\/([^\]]+)\] /.exec(raw);
    const line = prefix ? raw.slice(prefix[0].length) : raw;
    const space = line.indexOf(" ");
    const timestamp = line.slice(0, space);
    const content = line.slice(space + 1);
    let parsed: any = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      /* plain text */
    }
    if (parsed) {
      for (const k of ["level", "logger", "method", "status"]) {
        if (k in parsed && !session.columns.has(k)) {
          session.columns.add(k);
          columnsChanged = true;
        }
      }
    }
    const seq = ++session.nextSeq;
    session.entries.push({
      id: String(seq),
      seq,
      content,
      timestamp,
      data: parsed ?? { message: content },
      pod: prefix?.[1] ?? null,
      container: prefix?.[2] ?? null,
    });
  }
  // Same cap as the backend (logs::MAX_ENTRIES_PER_SESSION).
  if (session.entries.length > 20000) session.entries.splice(0, session.entries.length - 20000);
  return { columns_changed: columnsChanged, has_facets: session.facets.size > 0, total: session.entries.length };
}

function facetsOf(session: LogSession) {
  return [...session.facets.entries()].map(([property, f]) => {
    const totals = new Map<string, number>();
    for (const e of session.entries) {
      const key = facetKey(e, property);
      if (key === undefined) continue;
      totals.set(key, (totals.get(key) || 0) + 1);
    }
    for (const key of f.filtered) if (!totals.has(key)) totals.set(key, 0);
    return {
      property,
      match_type: f.match_type,
      values: [...totals.entries()].map(([value, total]) => ({ value, total, filtered: f.filtered.has(value) })),
    };
  });
}

function filteredEntries(session: LogSession, query: string, sinceSeq?: number) {
  let entries = session.entries;
  for (const [property, f] of session.facets) {
    if (f.filtered.size === 0) continue;
    entries = entries.filter((e) => f.filtered.has(facetKey(e, property) ?? ""));
  }
  if (query) {
    const q = query.toLowerCase();
    entries = entries.filter((e) => e.content.toLowerCase().includes(q) || e.pod?.toLowerCase().includes(q));
  }
  const filtered_total = entries.length;
  if (sinceSeq) entries = entries.filter((e) => e.seq > sinceSeq);
  return {
    entries,
    total: session.entries.length,
    filtered_total,
    oldest_seq: session.entries[0]?.seq ?? 0,
    latest_seq: session.entries[session.entries.length - 1]?.seq ?? 0,
  };
}

/* Mirrors logs::streaming: lines go into the session, the view is notified. */
function podsForTarget(context: string, namespace: string, target: any): any[] {
  const pods: any[] = (clusters[context] || clusters[CONTEXTS[0].name]).pods.filter(
    (p: any) => !namespace || p.metadata.namespace === namespace
  );
  if (target.kind === "pod") return pods.filter((p) => p.metadata.name === target.name).slice(0, 1);
  if (target.kind === "selector") {
    const pairs = String(target.selector)
      .split(",")
      .map((part) => part.split("="))
      .filter((kv) => kv.length === 2);
    return pods.filter((p) => pairs.every(([k, v]) => p.metadata.labels?.[k] === v));
  }
  return pods.slice(0, 1);
}

function startLogStream(sessionId: string, spec: any, onEvent: any) {
  const session = sessions.get(sessionId);
  if (!session) throw "The log session has ended";
  if (session.stream) clearInterval(session.stream);
  session.generation++;
  const generation = session.generation;
  session.entries = [];

  const pods = podsForTarget(spec.context, spec.namespace, spec.target);
  const running = pods.filter((p) => p.status.phase === "Running");
  const source = (p: any) =>
    (spec.container ? [spec.container] : p.spec.containers.map((c: any) => c.name)) as string[];
  const line = (p: any, container: string, ms: number, text: string) =>
    `[pod/${p.metadata.name}/${container}] ${nanoTimestamp(ms)} ${text.slice(text.indexOf(" ") + 1)}`;

  const emit = (lines: string[]) => {
    if (session.generation !== generation || lines.length === 0) return;
    const result = addLogData(session, lines.join("\n"));
    sendToChannel(onEvent, {
      type: "appended",
      latestSeq: session.nextSeq,
      total: session.entries.length,
      added: lines.length,
      columnsChanged: result.columns_changed,
    });
  };

  const tail = spec.previous ? 12 : Math.min(spec.tail ?? 60, 60);
  setTimeout(() => {
    if (session.generation !== generation) return;
    if (spec.target.kind === "selector") {
      sendToChannel(onEvent, {
        type: "sources",
        pods: pods.map((p) => ({ name: p.metadata.name, state: p.status.phase === "Running" ? "streaming" : "waiting" })),
      });
    }
    const now = Date.now();
    const initial: string[] = [];
    running.forEach((p, k) => {
      for (const container of source(p)) {
        logLines(tail).forEach((text, i) => initial.push(line(p, container, now - (tail - i) * 1700 - k * 410, text)));
      }
    });
    emit(initial);
    if (spec.target.kind === "selector" && pods.length > running.length) {
      sendToChannel(onEvent, { type: "notice", level: "info", message: `${pods.length - running.length} pods are not running yet` });
    }
    if (!spec.follow) {
      sendToChannel(onEvent, { type: "ended" });
      return;
    }
    let tick = 0;
    session.stream = setInterval(() => {
      const p = running[tick++ % Math.max(1, running.length)];
      if (!p) return;
      if (LOG_RATE > 0) {
        // ?lograte=N: N lines/s spread over the running pods, batched every
        // 100ms like the backend (perf testing).
        const batch: string[] = [];
        const now = Date.now();
        const perTick = Math.round(LOG_RATE / 10);
        const pool = logLines(64);
        for (let i = 0; i < perTick; i++) {
          const q = running[i % running.length];
          batch.push(line(q, source(q)[0], now - 100 + (i * 100) / perTick, pool[i % pool.length]));
        }
        emit(batch);
        return;
      }
      emit(logLines(2).map((text) => line(p, source(p)[0], Date.now(), text)));
    }, LOG_RATE > 0 ? 100 : 450);
  }, 120);
}

/* ----------------------------------------------------------------- helm -- */

const HELM_VALUES = (revision: number) =>
  [
    "image:",
    "  repository: ghcr.io/acme/payments-api",
    `  tag: v2.14.${revision >= 42 ? 3 : 2}`,
    `replicaCount: ${revision >= 41 ? 4 : 3}`,
    "resources:",
    "  requests:",
    "    cpu: 250m",
    "    memory: 256Mi",
    "ingress:",
    "  enabled: true",
    "  host: payments.acme.internal",
    ...(revision >= 40 ? ["podDisruptionBudget:", "  minAvailable: 2"] : []),
    "",
  ].join("\n");

const helmManifest = (tag: string, replicas: number, extraEnv = false) =>
  [
    "---",
    "# Source: payments-api/templates/service.yaml",
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    "  name: payments-api",
    "spec:",
    "  ports:",
    "    - port: 80",
    "      targetPort: 8080",
    "---",
    "# Source: payments-api/templates/deployment.yaml",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: payments-api",
    `  labels: { app.kubernetes.io/version: "${tag.slice(1)}" }`,
    "spec:",
    `  replicas: ${replicas}`,
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: payments-api",
    `          image: ghcr.io/acme/payments-api:${tag}`,
    "          env:",
    "            - name: LOG_LEVEL",
    "              value: info",
    ...(extraEnv ? ["            - name: FEATURE_FAST_REFUNDS", '              value: "true"'] : []),
    "",
  ].join("\n");

function helmWithValues(args: string[], values: string) {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const tag = /tag:\s*(\S+)/.exec(values)?.[1] ?? "v2.14.3";
  const replicas = Number(/replicaCount:\s*(\d+)/.exec(values)?.[1] ?? 4);
  if (args[0] === "template") return ok(helmManifest(tag, replicas, values.includes("fastRefunds")));
  if (args[0] === "upgrade") return ok(`Release "${args[1]}" has been upgraded. Happy Helming!\nNAME: ${args[1]}\nREVISION: 43\nSTATUS: deployed\n`);
  return ok("");
}

/* ---------------------------------------------------------------- shell -- */

async function shellExecute(program: string, args: string[]) {
  const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "" });
  const context = argValue(args, "--context") || argValue(args, "--kube-context") || CONTEXTS[0].name;

  if (program === "helm") {
    if (args[0] === "list") {
      const ns = argValue(args, "--namespace");
      const releases = clusters[context].helmReleases.filter((r) => !ns || r.namespace === ns);
      return ok(JSON.stringify(scenario === "empty" ? [] : releases));
    }
    if (args[0] === "search" && args.includes("--versions")) {
      const chart = args[2];
      return ok(
        JSON.stringify(
          ["2.15.0", "2.14.3", "2.14.2", "2.13.0", "2.12.1"].map((version) => ({
            name: `acme/${chart}`,
            version,
            app_version: version,
            description: `${chart} Helm chart`,
          }))
        )
      );
    }
    if (args[0] === "get" && args[1] === "values") return ok(HELM_VALUES(Number(argValue(args, "--revision") || 42)));
    if (args[0] === "get" && args[1] === "manifest") return ok(helmManifest("v2.14.3", 4));
    if (args[0] === "plugin") return ok("NAME\tVERSION\tDESCRIPTION\n");
    if (args[0] === "rollback") return ok("Rollback was a success! Happy Helming!\n");
    if (args[0] === "search") {
      return ok(
        JSON.stringify([
          { name: "bitnami/postgresql", version: "15.5.20", app_version: "16.3.0", description: "PostgreSQL is an object-relational database management system." },
          { name: "bitnami/redis", version: "19.6.4", app_version: "7.2.5", description: "Redis is an open source, advanced key-value store." },
          { name: "ingress-nginx/ingress-nginx", version: "4.11.1", app_version: "1.11.1", description: "Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer" },
          { name: "jetstack/cert-manager", version: "v1.15.1", app_version: "v1.15.1", description: "A Helm chart for cert-manager" },
          { name: "prometheus-community/kube-prometheus-stack", version: "61.3.2", app_version: "v0.75.2", description: "kube-prometheus-stack collects Kubernetes manifests, Grafana dashboards, and Prometheus rules." },
        ])
      );
    }
    if (args[0] === "history") {
      const history = [38, 39, 40, 41, 42].map((revision) => ({ revision, updated: new Date(Date.now() - (43 - revision) * 86400000 * 1.7).toISOString(), status: revision === 42 ? "deployed" : revision === 40 ? "failed" : "superseded", chart: `payments-api-2.14.${revision >= 42 ? 3 : 2}`, app_version: `2.14.${revision >= 42 ? 3 : 2}`, description: revision === 40 ? "Upgrade \"payments-api\" failed: context deadline exceeded" : revision === 38 ? "Install complete" : revision === 41 ? "Rollback to 39" : "Upgrade complete" }));
      return ok(JSON.stringify(history));
    }
    return ok("[]");
  }

  if (program === "kubectl") {
    if (args[0] === "describe") {
      const obj = findObject(context, args[1]);
      return ok(describe(obj?.kind || "Pod", obj));
    }
    if (args[0] === "get" && args[1]?.includes("/") && args.includes("--output=json")) {
      const obj = findObject(context, args[1]);
      return obj ? ok(JSON.stringify(obj)) : { code: 1, signal: null, stdout: "", stderr: `Error from server (NotFound): ${args[1]} not found` };
    }
    if (args[0] === "get" && args.includes("yaml")) {
      return ok(objectYaml(context, args[1]));
    }
    if (args[0] === "get") {
      return ok(kubectlGet(args));
    }
  }

  return ok("");
}

function shellSpawn(program: string, args: string[], onEvent: any) {
  if (program === "kubectl" && args[0] === "logs") {
    const lines = logLines(120);
    (async () => {
      await sleep(50);
      for (const line of lines) sendToChannel(onEvent, { event: "Stdout", payload: line });
    })();
  }
  return Math.floor(Math.random() * 10000);
}

/* ------------------------------------------------------------------ pty -- */

const PROMPT = "\x1b[38;5;111mpayments-api-7d9f8b6c4-x2klq\x1b[0m:\x1b[38;5;150m/app\x1b[0m$ ";
/* `kubectl debug` (pod: ephemeral container, node/…: node debugger pod). */
function startDebugPty(onEvent: any, argv: string[]) {
  const target = argv.find((a) => !a.startsWith("-") && a !== "kubectl" && a !== "debug") || "";
  const node = target.startsWith("node/") ? target.slice(5) : null;
  const prompt = node ? "\x1b[1;31mroot@" + node.split(".")[0] + "\x1b[0m:/# " : "/ # ";
  const lines = node
    ? [
        `Creating debugging pod node-debugger-${node.split(".")[0]}-x7k2p with container debugger on node ${node}.`,
        "If you don't see a command prompt, try pressing enter.",
        prompt + "uname -a",
        `Linux ${node} 6.1.97-104.177.amzn2023.x86_64 #1 SMP x86_64 GNU/Linux`,
        prompt + "crictl ps --name payments | head -3",
        "CONTAINER      IMAGE          CREATED       STATE     NAME            POD",
        "3f1c2a9e8b7d   4d2f0c1b9a8e   2 hours ago   Running   payments-api    payments-api-7d9f8b6c4-x2klq",
        prompt,
      ]
    : [
        `Targeting container "${(argv.find((a) => a.startsWith("--target=")) || "").slice(9)}". If you don't see processes from this container it may be because the container runtime doesn't support this feature.`,
        `Defaulting debug container name to debugger-q8m2t.`,
        "If you don't see a command prompt, try pressing enter.",
        prompt + "ps aux",
        "PID   USER     TIME  COMMAND",
        "    1 app       0:42 /app/server --config /app/config.yaml",
        "   38 root      0:00 sh",
        "   45 root      0:00 ps aux",
        prompt + `nslookup ledger.payments.svc.cluster.local`,
        "Server:		172.20.0.10",
        "Name:	ledger.payments.svc.cluster.local",
        "Address: 172.20.41.19",
        prompt,
      ];
  setTimeout(() => sendToChannel(onEvent, encoder.encode(lines.join("\r\n")).buffer), 150);
}

function startPty(onEvent: any, banner: string[]) {
  setTimeout(() => {
    const text = [
      ...banner,
      PROMPT + "ls -la",
      "total 24",
      "drwxr-xr-x 1 app  app  4096 Oct  4 09:12 \x1b[1;34m.\x1b[0m",
      "drwxr-xr-x 1 root root 4096 Oct  4 09:12 \x1b[1;34m..\x1b[0m",
      "-rwxr-xr-x 1 app  app  1024 Oct  4 09:12 \x1b[1;32mserver\x1b[0m",
      "-rw-r--r-- 1 app  app   312 Oct  4 09:12 config.yaml",
      PROMPT + "env | grep LOG",
      "LOG_LEVEL=info",
      PROMPT,
    ].join("\r\n");
    sendToChannel(onEvent, encoder.encode(text).buffer);
  }, 100);
}

/* ---------------------------------------------------------------- watch -- */

/*
 * WatchHub mock: per scope a `ready` status + snapshot, then (scenario
 * `large`) a stream of batched deltas, like src-tauri/src/watch.
 */
const watchSubscriptions = new Map<number, { channel: any; context: string; key: string; scopes: string[] }>();
let watchIds = 0;
let resourceVersion = 1000;

const tagRow = (item: any, context: string, kubeConfig: string) => ({
  ...item,
  metadata: {
    resourceVersion: String(item.metadata?.resourceVersion ?? resourceVersion),
    ...item.metadata,
    context,
    kubeConfig,
  },
});

/* Cluster scoped kinds and API groups, like the backend's discovery. */
const CLUSTER_SCOPED = new Set([
  "nodes",
  "namespaces",
  "persistentvolumes",
  "storageclasses",
  "clusterroles",
  "clusterrolebindings",
  "customresourcedefinitions",
  "ingressclasses",
  "priorityclasses",
  "apiservices",
  "mutatingwebhookconfigurations",
  "validatingwebhookconfigurations",
]);
const API_VERSIONS: Record<string, string> = {
  deployments: "apps/v1",
  statefulsets: "apps/v1",
  daemonsets: "apps/v1",
  replicasets: "apps/v1",
  jobs: "batch/v1",
  cronjobs: "batch/v1",
  ingresses: "networking.k8s.io/v1",
  ingressclasses: "networking.k8s.io/v1",
  networkpolicies: "networking.k8s.io/v1",
  storageclasses: "storage.k8s.io/v1",
  clusterroles: "rbac.authorization.k8s.io/v1",
  clusterrolebindings: "rbac.authorization.k8s.io/v1",
  roles: "rbac.authorization.k8s.io/v1",
  rolebindings: "rbac.authorization.k8s.io/v1",
  customresourcedefinitions: "apiextensions.k8s.io/v1",
};

function watchSubscribe(request: any, channel: any) {
  const { context, kubeConfig = "", resource, namespaces = [] } = request;
  const key = resourceKey(resource);
  const cluster = clusters[context];
  if (!cluster) throw new Error(`context ${context} not found`);

  const clusterScoped = CLUSTER_SCOPED.has(key);
  const scopes: string[] =
    clusterScoped || namespaces.length === 0 || namespaces.some((ns: string) => ns === "all" || ns === "")
      ? [""]
      : [...new Set<string>(namespaces)].sort();
  const id = ++watchIds;
  watchSubscriptions.set(id, { channel, context, key, scopes });

  // Like Entry::add_sink: the current status right away.
  for (const scope of scopes) sendToChannel(channel, { type: "status", scope, state: "syncing" });

  setTimeout(() => {
    for (const scope of scopes) {
      if (scenario === "error" && key !== "podmetrics") {
        sendToChannel(channel, {
          type: "status",
          scope,
          state: "error",
          message: `Unable to connect to the server: dial tcp 10.0.12.34:443: i/o timeout (context ${context})`,
        });
        continue;
      }
      const all: any[] =
        scenario === "empty" && key !== "namespaces" ? [] : (cluster as any)[key] || [];
      const items = all
        .filter((i) => !scope || i.metadata?.namespace === scope)
        .map((i) => tagRow(i, context, kubeConfig));
      sendToChannel(channel, { type: "status", scope, state: "ready" });
      sendToChannel(channel, { type: "snapshot", scope, items });
    }
  }, 60);

  return {
    id,
    scopes,
    namespaced: !clusterScoped,
    apiVersion: API_VERSIONS[key] || "v1",
    kind: request.kind || "",
  };
}

/*
 * Live changes on demand (graph perf / QA): add, modify or remove an object
 * of the first context. Pushed to its watchers as a delta, and kept in the
 * fixture list so the kubectl mock (polling path) sees it too.
 *   __harnessMutate("deployments", "orders-api", (d) => ({ ...d, status: {...} }))
 *   __harnessAdd("configmaps", { kind: "ConfigMap", metadata: {...} })
 *   __harnessRemove("pods", "orders-api-abc")
 */
function emitWatchChange(key: string, change: { added?: any[]; modified?: any[]; deleted?: any[] }) {
  const context = CONTEXTS[0].name;
  for (const sub of watchSubscriptions.values()) {
    if (sub.key !== key || sub.context !== context) continue;
    for (const scope of sub.scopes) {
      const pick = (list: any[] = []) => list.filter((o) => !scope || o.metadata?.namespace === scope);
      const added = pick(change.added).map((o) => tagRow(o, context, KUBECONFIG));
      const modified = pick(change.modified).map((o) => tagRow(o, context, KUBECONFIG));
      const deleted = pick(change.deleted).map((o) => o.metadata.uid);
      if (added.length || modified.length || deleted.length) {
        sendToChannel(sub.channel, { type: "delta", scope, added, modified, deleted });
      }
    }
  }
}
const harnessList = (key: string): any[] => {
  const cluster = clusters[CONTEXTS[0].name] as any;
  return (cluster[key] = cluster[key] || []);
};
Object.assign(window as any, {
  __harnessMutate(key: string, name: string, update: (object: any) => any) {
    const list = harnessList(key);
    const index = list.findIndex((o) => o.metadata?.name === name);
    if (index < 0) throw new Error(`${key}/${name} not found`);
    const next = update(structuredClone(list[index]));
    next.metadata = { ...next.metadata, resourceVersion: String(++resourceVersion) };
    list[index] = next;
    emitWatchChange(key, { modified: [next] });
    return next;
  },
  __harnessAdd(key: string, object: any) {
    object.metadata = { uid: `harness-${++resourceVersion}`, ...object.metadata, resourceVersion: String(resourceVersion) };
    harnessList(key).push(object);
    emitWatchChange(key, { added: [object] });
    return object;
  },
  __harnessRemove(key: string, name: string) {
    const list = harnessList(key);
    const index = list.findIndex((o) => o.metadata?.name === name);
    if (index < 0) throw new Error(`${key}/${name} not found`);
    const [removed] = list.splice(index, 1);
    emitWatchChange(key, { deleted: [removed] });
    return removed;
  },
});

if (scenario === "large") {
  // ~20 pod changes per second, batched like the backend (150 ms). The
  // kubectl mock serves the same mutated list, so polling sees them too.
  setInterval(() => {
    const cluster = CLUSTERS[CONTEXTS[0].name];
    const modified = Array.from({ length: 3 }, () => {
      const i = Math.floor(Math.random() * cluster.pods.length);
      const pod = cluster.pods[i];
      const next = {
        ...pod,
        metadata: { ...pod.metadata, resourceVersion: String(++resourceVersion) },
        status: {
          ...pod.status,
          containerStatuses: (pod.status?.containerStatuses || []).map((c: any) => ({
            ...c,
            restartCount: (c.restartCount || 0) + 1,
          })),
        },
      };
      cluster.pods[i] = next;
      return next;
    });
    for (const sub of watchSubscriptions.values()) {
      if (sub.key !== "pods" || sub.context !== CONTEXTS[0].name) continue;
      for (const scope of sub.scopes) {
        const inScope = modified
          .filter((p) => !scope || p.metadata.namespace === scope)
          .map((p) => tagRow(p, sub.context, KUBECONFIG));
        if (inScope.length) {
          sendToChannel(sub.channel, { type: "delta", scope, added: [], modified: inScope, deleted: [] });
        }
      }
    }
  }, 150);
}

/* Usage of a PodMetric: [millicores, bytes] (sum of the containers). */
function metricUsage(metric: any): [number, number] {
  let cpu = 0;
  let memory = 0;
  for (const c of metric.containers || []) {
    const q = String(c.usage?.cpu ?? "0");
    cpu += q.endsWith("n") ? parseFloat(q) / 1e6 : q.endsWith("m") ? parseFloat(q) : parseFloat(q) * 1000;
    const m = String(c.usage?.memory ?? "0");
    const unit = m.match(/(Ki|Mi|Gi)$/)?.[1];
    memory += parseFloat(m) * (unit === "Gi" ? 1024 ** 3 : unit === "Mi" ? 1024 ** 2 : unit === "Ki" ? 1024 : 1);
  }
  return [cpu, memory];
}

/*
 * Like the metrics service: status, the latest sample and the ring buffer
 * history ([ms, millicores, bytes] per "ns/name", 15 s apart) on subscribe.
 * The history is a deterministic wave around the current usage, so the
 * sparkline columns have something to draw.
 */
function metricsSubscribe(request: any, channel: any) {
  const { context, kubeConfig = "", namespaces = [] } = request;
  const cluster = clusters[context];
  sendToChannel(channel, { type: "status", state: "syncing" });
  setTimeout(() => {
    if (!cluster || scenario === "error") {
      sendToChannel(channel, {
        type: "status",
        state: "unavailable",
        message: "The metrics API (metrics.k8s.io) is not available; is metrics-server installed?",
      });
      return;
    }
    const all = namespaces.length === 0 || namespaces.includes("all");
    const now = Date.now();
    const pods = cluster.podmetrics
      .filter((m) => all || namespaces.includes(m.metadata?.namespace))
      .map((m) => tagRow({ ...m, timestamp: new Date(now).toISOString() }, context, kubeConfig));
    const history: Record<string, [number, number, number][]> = {};
    pods.forEach((m: any, index: number) => {
      const [cpu, memory] = metricUsage(m);
      history[`${m.metadata.namespace}/${m.metadata.name}`] = Array.from({ length: 40 }, (_, i) => {
        const wave = 1 + 0.35 * Math.sin((i + index * 3) / 4) + 0.15 * Math.sin((i * 7 + index) / 3);
        const ts = now - (39 - i) * 15_000;
        return [ts, i === 39 ? cpu : Math.max(0, cpu * wave), i === 39 ? memory : memory * (0.9 + 0.1 * wave)];
      });
    });
    sendToChannel(channel, { type: "status", state: "ready" });
    sendToChannel(channel, { type: "sample", timestamp: now, pods, nodes: [] });
    sendToChannel(channel, { type: "history", pods: history, nodes: {} });
  }, 80);
  return ++watchIds;
}

/* ------------------------------------------------------------- dispatch -- */

const ptyChannels = new Map<string, any>();

/* ------------------------------------------------------------------ fs -- */

const fsKey = (path: string) => `harness-fs:${path}`;

/*
 * Files the theme import dialog picks (Settings › Appearance › Import
 * file…): a VS Code light / dark pair that gets paired, and a file that
 * isn't a theme.
 */
const PICKED_THEME_FILES: Record<string, string> = (() => {
  const [latte, mocha] = openVsxThemes();
  const renamed = (text: string, name: string) =>
    JSON.stringify({ ...JSON.parse(text), name }, null, 2);
  return {
    [`${HOME}/Downloads/harbor-light-color-theme.json`]: renamed(latte!.text, "Harbor Light"),
    [`${HOME}/Downloads/harbor-dark-color-theme.json`]: renamed(mocha!.text, "Harbor Dark"),
    [`${HOME}/Downloads/notes.txt`]: "Not a theme.",
  };
})();

const readFile = (path: string): string | null => {
  const stored = sessionStorage.getItem(fsKey(path));
  if (stored === null && path in PICKED_THEME_FILES) return PICKED_THEME_FILES[path]!;
  if (path !== "settings.json") return stored;
  if (!stored) return JSON.stringify(settings);
  // The ?theme / ?themeId knobs win over choices saved earlier.
  const saved = JSON.parse(stored);
  const appearance = { ...saved.appearance, colorScheme: theme };
  if (themeId) Object.assign(appearance, { lightTheme: themeId, darkTheme: themeId });
  return JSON.stringify({ ...saved, appearance });
};

/* Directories are implicit: a path is a directory when files live below it. */
const fsDirPrefix = (dir: string) => {
  const trimmed = String(dir).replace(/\/+$/, "");
  return fsKey(trimmed ? `${trimmed}/` : "");
};
const fsBelow = (dir: string) => {
  const prefix = fsDirPrefix(dir);
  return Object.keys(sessionStorage).filter((key) => key.startsWith(prefix));
};
/* Directories made with mkdir (empty ones have no files to imply them). */
const fsDirsKey = "harness-fs-dirs";
const madeDirs = (): string[] => JSON.parse(sessionStorage.getItem(fsDirsKey) || "[]");
const fsMkdir = (dir: string) => {
  const trimmed = String(dir).replace(/\/+$/, "");
  if (!madeDirs().includes(trimmed)) sessionStorage.setItem(fsDirsKey, JSON.stringify([...madeDirs(), trimmed]));
};
const isFsDir = (path: string) =>
  path === "" || fsBelow(path).length > 0 || madeDirs().includes(String(path).replace(/\/+$/, ""));

/** `readDir` entries: direct children (files, and directories implied by deeper files). */
const readDir = (dir: string) => {
  if (!isFsDir(dir)) throw new Error(`No such directory: ${dir}`);
  const prefix = fsDirPrefix(dir);
  const entries = new Map<string, boolean>();
  for (const key of fsBelow(dir)) {
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    entries.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
  }
  return [...entries].map(([name, isDirectory]) => ({
    name,
    isDirectory,
    isFile: !isDirectory,
    isSymlink: false,
  }));
};

const fsStat = (path: string) => {
  const contents = sessionStorage.getItem(fsKey(path));
  const isDirectory = contents === null && isFsDir(path);
  if (contents === null && !isDirectory) throw new Error(`No such file or directory: ${path}`);
  const now = Date.now();
  return {
    isFile: !isDirectory,
    isDirectory,
    isSymlink: false,
    size: contents === null ? 0 : encoder.encode(contents).length,
    mtime: now,
    atime: now,
    birthtime: now,
    readonly: false,
    fileAttributes: null,
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
  };
};

/* fs watchers (plugin-fs `watch`): get a WatchEvent for every change below their paths. */
const fsWatchers = new Map<number, { paths: string[]; channel: any }>();
let fsWatchIds = 1000;
const notifyFsWatchers = (path: string, kind: "create" | "modify" | "remove") => {
  const type =
    kind === "modify"
      ? { modify: { kind: "data", mode: "any" } }
      : { [kind]: { kind: "file" } };
  for (const { paths, channel } of fsWatchers.values()) {
    const watched = paths.some((dir) => {
      const trimmed = String(dir).replace(/\/+$/, "");
      return path === trimmed || path.startsWith(`${trimmed}/`);
    });
    if (watched) sendToChannel(channel, { type, paths: [path], attrs: {} });
  }
};
const fsRemove = (path: string, recursive: boolean) => {
  if (sessionStorage.getItem(fsKey(path)) !== null) {
    sessionStorage.removeItem(fsKey(path));
    notifyFsWatchers(path, "remove");
    return;
  }
  const below = fsBelow(path);
  if (below.length === 0) throw new Error(`No such file or directory: ${path}`);
  if (!recursive) throw new Error(`Directory not empty: ${path}`);
  for (const key of below) {
    sessionStorage.removeItem(key);
    notifyFsWatchers(key.slice(fsKey("").length), "remove");
  }
};

/*
 * Open VSX fixtures. Search filters by query; install returns the same light
 * and dark theme for every extension (gpl-theme fails the licence check).
 */
const openVsxSearch = (query = "", offset = 0, size = 24) => {
  const q = query.trim().toLowerCase();
  const hits = OPENVSX_EXTENSIONS.filter(
    (e) => !q || `${e.displayName} ${e.name} ${e.namespace} ${e.description}`.toLowerCase().includes(q)
  );
  const extensions = hits.slice(offset, offset + Math.min(size, 50)).map((e) => ({
    ...e,
    iconUrl: undefined,
  }));
  return { offset, totalSize: hits.length, extensions };
};
const openVsxInstall = (namespace: string, name: string) => {
  const extension = OPENVSX_EXTENSIONS.find((e) => e.namespace === namespace && e.name === name);
  if (!extension) throw `Open VSX extension details could not be found on Open VSX.`;
  if (extension.name === "gpl-theme") {
    throw `"${extension.displayName}" is licensed under GPL-3.0, which is not on the allowlist. Only permissively licensed themes (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, CC0-1.0, 0BSD, Zlib) can be installed.`;
  }
  return { extension: { ...extension, license: "MIT" }, themes: openVsxThemes() };
};

mockIPC(
  async (cmd: string, payload: any) => {
    const p = payload || {};
    switch (cmd) {
      // fs / path / app / os / updater / window / clipboard
      case "plugin:fs|exists":
        return isFsDir(p.path) || readFile(p.path) !== null;
      case "plugin:fs|read_dir":
        return readDir(p.path);
      case "plugin:fs|stat":
      case "plugin:fs|lstat":
        return fsStat(p.path);
      case "plugin:fs|remove":
        fsRemove(p.path, !!p.options?.recursive);
        return null;
      case "plugin:fs|watch": {
        const id = ++fsWatchIds;
        fsWatchers.set(id, { paths: p.paths || [], channel: p.onEvent });
        return id;
      }
      case "plugin:fs|unwatch":
        fsWatchers.delete(p.rid);
        return null;
      case "plugin:resources|close":
        // plugin-fs closes watchers as resources (Watcher.close()).
        fsWatchers.delete(p.rid);
        return null;
      case "plugin:fs|read_text_file": {
        if (delay && p.path === "settings.json") await sleep(delay);
        const contents = readFile(p.path);
        if (contents === null) throw new Error(`No such file: ${p.path}`);
        return Array.from(encoder.encode(contents));
      }
      case "plugin:fs|mkdir":
        fsMkdir(p.path);
        return null;
      case "plugin:fs|write_text_file":
        return null;
      case "plugin:path|resolve_directory":
        // 13: BaseDirectory.AppConfig (the themes folder lives below it).
        return p.directory === 13 ? `${HOME}/.config/jet-pilot` : HOME;
      case "plugin:path|join":
        return (p.paths as string[]).join("/").replace(/\/{2,}/g, "/");
      case "plugin:app|version":
        return "1.35.0";
      case "plugin:app|name":
        return "JET Pilot";
      case "plugin:app|tauri_version":
        return "2.9.0";
      case "plugin:updater|check":
        return null;
      case "plugin:window|is_maximized":
        return false;
      case "plugin:clipboard-manager|write_text":
        return null;

      // backend commands
      case "write_log":
      case "update_log_level":
      case "set_current_kubeconfig":
        return null;
      case "get_logs":
        return p.since
          ? []
          : Array.from({ length: 40 }, (_, i) => ({
              seq: i + 1,
              timestamp: new Date(Date.now() - (40 - i) * 30000).toISOString(),
              level: ["INFO", "DEBUG", "WARN", "ERROR"][i % 7 === 0 ? 3 : i % 5 === 0 ? 2 : i % 2],
              target: ["jet_pilot::kube", "jet_pilot::port_forward", "jet_pilot::logs"][i % 3],
              message: ["Listing pods for context prod-eu-west-1", "Port-forward ready on 127.0.0.1:8080", "Structured logging session started"][i % 3],
            }));
      case "list_port_forwards":
        return scenario === "default"
          ? [
              {
                id: "pf-1",
                kubeConfig: KUBECONFIG,
                context: CONTEXTS[0].name,
                namespace: "payments",
                objectType: "service",
                objectName: "payments-api",
                objectPort: 80,
                localPort: 8080,
                address: "127.0.0.1",
                status: "ready",
                error: null,
                startedAtMs: Date.now() - 600000,
                expiresAtMs: null,
              },
            ]
          : [];
      case "get_current_context":
        return scenario === "nocontext" ? "" : CONTEXTS[0].name;
      case "list_contexts":
        return CONTEXTS.map((c) => ({ name: c.name, context: { namespace: c.namespace } }));
      case "list_namespaces":
        await sleep(150);
        return (NAMESPACES[p.context] || []).map((name) => ({ metadata: { name } }));
      case "get_context_auth_info":
        return { execCommand: null, awsProfile: null };
      case "get_core_api_versions":
        if (delay) await sleep(delay * 2);
        return ["v1"];
      case "get_core_api_resources":
        return CORE_RESOURCES;
      case "get_api_groups":
        return API_GROUPS.map((g) => ({
          name: g.name,
          versions: [{ groupVersion: g.version, version: g.version.split("/")[1] }],
          preferredVersion: { groupVersion: g.version, version: g.version.split("/")[1] },
        }));
      case "get_api_group_resources":
        return API_GROUPS.find((g) => g.version === p.apiGroupVersion)?.resources || [];
      case "run_kubectl":
        await sleep(120);
        return kubectlGet(p.args);
      case "apply_manifest":
        await sleep(p.dryRun ? 350 : 250);
        return applyManifest(p);
      case "get_openapi_v3_schema":
        return openapiDocument(p.apiVersion);

      // live watches + metrics (src-tauri/src/watch, metrics.rs)
      case "watch_subscribe":
        await sleep(20);
        return watchSubscribe(p.request, p.onEvent);
      case "watch_unsubscribe":
        watchSubscriptions.delete(p.id);
        return null;
      case "watch_restart":
      case "watch_reset":
      case "watch_set_paused":
      case "metrics_unsubscribe":
      case "metrics_reset":
      case "log_stream_reset":
        return null;
      case "watch_get": {
        for (const cluster of Object.values(CLUSTERS)) {
          for (const list of Object.values(cluster) as any[][]) {
            const found = Array.isArray(list) && list.find((o) => o?.metadata?.uid === p.uid);
            if (found) return found;
          }
        }
        throw new Error(`Object ${p.uid} is not cached`);
      }
      case "watch_stats":
        return { watchers: watchSubscriptions.size, subscriptions: watchSubscriptions.size, objects: 0, idle: 0, paused: false };
      case "metrics_subscribe":
        return metricsSubscribe(p.request, p.onEvent);

      // themes (openvsx.rs, themes.rs)
      case "openvsx_search":
        await sleep(250);
        return openVsxSearch(p.query, p.offset ?? 0, p.size ?? 24);
      case "openvsx_install":
        await sleep(600);
        return openVsxInstall(p.namespace, p.name);
      case "open_themes_folder":
        return `${HOME}/.config/jet-pilot/themes`;

      // shell plugin
      case "plugin:shell|execute":
        await sleep(80);
        return shellExecute(p.program, p.args);
      case "plugin:shell|spawn":
        return shellSpawn(p.program, p.args, p.onEvent);
      case "plugin:shell|kill":
      case "plugin:shell|stdin_write":
      case "plugin:shell|open":
        return null;

      // structured logging
      case "start_structured_logging_session": {
        const id = `session-${++sessionCounter}`;
        sessions.set(id, { entries: [], nextSeq: 0, facets: new Map(), columns: new Set(), generation: 0 });
        return id;
      }
      case "end_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        if (s?.stream) clearInterval(s.stream);
        sessions.delete(p.sessionId);
        return null;
      }
      case "run_helm_with_values":
        await sleep(300);
        return helmWithValues(p.args, p.values);
      case "start_log_stream":
        startLogStream(p.sessionId, p.spec, p.onEvent);
        return null;
      case "stop_log_stream": {
        const s = sessions.get(p.sessionId);
        if (s?.stream) clearInterval(s.stream);
        if (s) s.generation++;
        return null;
      }
      case "export_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        return s ? filteredEntries(s, p.searchQuery).entries.length : 0;
      }
      case "plugin:dialog|save":
        return p.options?.defaultPath
          ? `${HOME}/Downloads/${p.options.defaultPath}`
          : `${HOME}/Downloads/export.log`;
      case "plugin:dialog|open":
        if (p.options?.filters?.some((filter: { name: string }) => filter.name === "Themes")) {
          return Object.keys(PICKED_THEME_FILES);
        }
        return `${HOME}/Downloads/config.yaml`;
      case "repurpose_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        if (s) s.entries = [];
        return null;
      }
      case "add_data_to_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        return s ? addLogData(s, p.data) : null;
      }
      case "get_columns_for_structured_logging_session":
        return [...(sessions.get(p.sessionId)?.columns || [])];
      case "get_facets_for_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        return s ? facetsOf(s) : [];
      }
      case "add_facet_to_structured_logging_session":
        sessions.get(p.sessionId)?.facets.set(p.property, { match_type: p.matchType, filtered: new Set() });
        return null;
      case "remove_facet_from_structured_logging_session":
        sessions.get(p.sessionId)?.facets.delete(p.property);
        return null;
      case "set_facet_match_type_for_structured_logging_session": {
        const f = sessions.get(p.sessionId)?.facets.get(p.property);
        if (f) f.match_type = p.matchType;
        return null;
      }
      case "set_filtered_for_facet_value": {
        const f = sessions.get(p.sessionId)?.facets.get(p.property);
        if (f) (p.filtered ? f.filtered.add(p.value) : f.filtered.delete(p.value));
        return null;
      }
      case "get_filtered_data_for_structured_logging_session": {
        const s = sessions.get(p.sessionId);
        return s
          ? filteredEntries(s, p.searchQuery, p.sinceSeq)
          : { entries: [], total: 0, filtered_total: 0, oldest_seq: 0, latest_seq: 0 };
      }

      // pty
      case "create_tty_session":
      case "create_local_terminal_session": {
        const id = `pty-${Math.random().toString(36).slice(2)}`;
        ptyChannels.set(id, p.onEvent);
        const argv: string[] = p.initCommand || [];
        if (argv[1] === "debug") startDebugPty(p.onEvent, argv);
        else startPty(p.onEvent, []);
        return id;
      }
      case "write_to_pty": {
        const channel = ptyChannels.get(p.sessionId);
        if (channel) sendToChannel(channel, encoder.encode(String(p.data).replace(/\r/g, "\r\n")).buffer);
        return null;
      }
      case "resize_pty":
      case "stop_tty_session":
        return null;

      // port forwarding
      case "start_port_forward":
        return { ...p.spec, id: `pf-${Date.now()}`, status: "ready", error: null, startedAtMs: Date.now(), expiresAtMs: null };
      case "stop_port_forward":
        return null;

      // object commands (kubernetes.rs)
      case "delete_pod":
        await sleep(150);
        return { Deleted: p.name };
      case "trigger_cronjob":
        await sleep(150);
        return true;
      case "replace_pod":
        await sleep(200);
        return p.object;
      case "login_exec_auth":
        await sleep(400);
        return { command: "kubelogin", stdout: "", stderr: "" };

      default:
        if (!cmd.startsWith("plugin:event|")) {
          console.warn("[harness] unhandled IPC", cmd, p);
        }
        return null;
    }
  },
  { shouldMockEvents: true }
);

/*
 * plugin-fs sends the path of writes as a request header, which mockIPC
 * drops: store writes here, before they reach the mock.
 */
const internals = (window as any).__TAURI_INTERNALS__;
const mockedInvoke = internals.invoke;
internals.invoke = async (cmd: string, args: any, options: any) => {
  if (cmd === "plugin:fs|write_text_file" && options?.headers?.path) {
    const path = decodeURIComponent(options.headers.path);
    const existed = sessionStorage.getItem(fsKey(path)) !== null;
    sessionStorage.setItem(fsKey(path), new TextDecoder().decode(args));
    notifyFsWatchers(path, existed ? "modify" : "create");
    return null;
  }
  return mockedInvoke(cmd, args, options);
};

(window as any).__harness = { theme, os, scenario, polling };
