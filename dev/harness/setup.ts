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
 *
 * `large` scales the first context to 5000 pods with a stream of live
 * changes (watch deltas) to exercise the list views; `large-graph` swaps the
 * first context for a 2,000+ object topology for the resource graph.
 * Editor scenarios: `conflict` bumps an object's resourceVersion after its
 * first fetch (stale-edit flow); `compare` activates a second context.
 *
 * Files the app writes (settings.json, discovery cache, ...) live in
 * sessionStorage, so a reload sees them (restored tabs, workspaces).
 * `?fresh=1` clears them.
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
  describe,
  logLines,
} from "./fixtures";

const params = new URLSearchParams(location.search);
if (params.get("fresh")) {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("harness-fs:")) sessionStorage.removeItem(key);
  }
}
const delay = Number(params.get("delay") || 0);
for (const key of ["theme", "os", "scenario", "polling"]) {
  const value = params.get(key);
  if (value) localStorage.setItem(`harness-${key}`, value);
}
const theme = localStorage.getItem("harness-theme") || "dark";
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
  appearance: { colorScheme: theme },
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

/* ---------------------------------------------------------------- kubectl */

const argValue = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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

interface LogSession {
  entries: { id: string; seq: number; content: string; timestamp: string; data: any }[];
  facets: Map<string, { match_type: "AND" | "OR"; filtered: Set<string> }>;
  columns: Set<string>;
}
const sessions = new Map<string, LogSession>();
let sessionCounter = 0;

function addLogData(session: LogSession, data: string) {
  let columnsChanged = false;
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
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
    const seq = session.entries.length + 1;
    session.entries.push({ id: String(seq), seq, content, timestamp, data: parsed });
  }
  return { columns_changed: columnsChanged, has_facets: session.facets.size > 0, total: session.entries.length };
}

function facetsOf(session: LogSession) {
  return [...session.facets.entries()].map(([property, f]) => {
    const totals = new Map<string, number>();
    for (const e of session.entries) {
      const v = e.data?.[property];
      if (v === undefined) continue;
      totals.set(String(v), (totals.get(String(v)) || 0) + 1);
    }
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
    entries = entries.filter((e) => f.filtered.has(String(e.data?.[property])));
  }
  if (query) entries = entries.filter((e) => e.content.includes(query));
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
      return ok(JSON.stringify([1, 2, 3].map((revision) => ({ revision, updated: new Date(Date.now() - (4 - revision) * 86400000).toISOString(), status: revision === 3 ? "deployed" : "superseded", chart: "payments-api-2.14.3", app_version: "2.14.3", description: revision === 3 ? "Upgrade complete" : "Install complete" }))));
    }
    return ok("[]");
  }

  if (program === "kubectl") {
    if (args[0] === "describe") {
      const obj = findObject(context, args[1]);
      return ok(describe(obj?.kind || "Pod", obj));
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

function watchSubscribe(request: any, channel: any) {
  const { context, kubeConfig = "", resource, namespaces = [] } = request;
  const key = resourceKey(resource);
  const cluster = CLUSTERS[context];
  if (!cluster) throw new Error(`context ${context} not found`);

  const clusterScoped = ["nodes", "namespaces", "persistentvolumes"].includes(key);
  const scopes: string[] =
    clusterScoped || namespaces.length === 0 || namespaces.includes("all") ? [""] : [...namespaces].sort();
  const id = ++watchIds;
  watchSubscriptions.set(id, { channel, context, key, scopes });

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

  return { id, scopes, namespaced: !clusterScoped, apiVersion: "v1", kind: request.kind || "" };
}

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

function metricsSubscribe(request: any, channel: any) {
  const { context, kubeConfig = "", namespaces = [] } = request;
  const cluster = CLUSTERS[context];
  setTimeout(() => {
    if (!cluster || scenario === "error") {
      sendToChannel(channel, { type: "status", state: "unavailable", message: "metrics-server not installed" });
      return;
    }
    const all = namespaces.length === 0 || namespaces.includes("all");
    const pods = cluster.podmetrics
      .filter((m) => all || namespaces.includes(m.metadata?.namespace))
      .map((m) => tagRow(m, context, kubeConfig));
    sendToChannel(channel, { type: "status", state: "ready" });
    sendToChannel(channel, { type: "sample", timestamp: Date.now(), pods, nodes: [] });
  }, 80);
  return ++watchIds;
}

/* ------------------------------------------------------------- dispatch -- */

const ptyChannels = new Map<string, any>();

/* ------------------------------------------------------------------ fs -- */

const fsKey = (path: string) => `harness-fs:${path}`;
const readFile = (path: string): string | null => {
  const stored = sessionStorage.getItem(fsKey(path));
  if (path !== "settings.json") return stored;
  if (!stored) return JSON.stringify(settings);
  // The ?theme knob wins over a colour scheme saved earlier.
  const saved = JSON.parse(stored);
  return JSON.stringify({ ...saved, appearance: { ...saved.appearance, colorScheme: theme } });
};

mockIPC(
  async (cmd: string, payload: any) => {
    const p = payload || {};
    switch (cmd) {
      // fs / path / app / os / updater / window / clipboard
      case "plugin:fs|exists":
        return p.path === "" || readFile(p.path) !== null;
      case "plugin:fs|read_text_file": {
        if (delay && p.path === "settings.json") await sleep(delay);
        const contents = readFile(p.path);
        if (contents === null) throw new Error(`No such file: ${p.path}`);
        return Array.from(encoder.encode(contents));
      }
      case "plugin:fs|write_text_file":
      case "plugin:fs|mkdir":
        return null;
      case "plugin:path|resolve_directory":
        return HOME;
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
        sessions.set(id, { entries: [], facets: new Map(), columns: new Set() });
        return id;
      }
      case "end_structured_logging_session":
        sessions.delete(p.sessionId);
        return null;
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
        startPty(p.onEvent, []);
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
    sessionStorage.setItem(fsKey(path), new TextDecoder().decode(args));
    return null;
  }
  return mockedInvoke(cmd, args, options);
};

(window as any).__harness = { theme, os, scenario, polling };
