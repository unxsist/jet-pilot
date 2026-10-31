/*
 * Screenshots key screens of the harness (npm run harness) in dark + light.
 *
 *   node dev/harness/shoot.mjs <prefix> [screen...]
 *
 * Needs playwright-core (resolved from PLAYWRIGHT_CORE or NODE_PATH, it is
 * not a project dependency) and a Chromium (CHROMIUM, default
 * /usr/bin/chromium). Output: $OUT_DIR (default /tmp/jet-ui-shots)/<prefix>-<screen>-<theme>.png
 *
 * THEMES=dracula,catppuccin shoots every screen per app theme (?themeId=)
 * and appearance: <prefix>-<screen>-<appearance>-<themeId>.png.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const BASE = process.env.HARNESS_URL || "http://localhost:5174";
const OUT = process.env.OUT_DIR || "/tmp/jet-ui-shots";
const prefix = process.argv[2] || "shot";
const only = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const firstRow = (page) => page.locator("tbody tr").filter({ hasText: /\w/ }).first();

const screens = {
  pods: { url: "/pods", ready: "tbody tr td" },
  deployments: { url: "/deployments?resource=deployments&kind=Deployment", ready: "tbody tr td" },
  helm: { url: "/helm-releases?resource=release&kind=Release", ready: "tbody tr td" },
  "side-panel": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).nth(1).click();
      await wait(1200);
    },
  },
  "context-switcher": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator('[aria-haspopup="menu"]').first().click();
      await wait(400);
      await page.locator('[role="menuitem"]', { hasText: "prod-eu-west-1" }).first().hover();
      await wait(900);
    },
  },
  "command-palette": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.keyboard.press("Control+k");
      await wait(600);
    },
  },
  "cluster-overview": { url: "/cluster-overview", ready: ".vue-flow__node-k8s", settle: 2500 },
  "graph-problems": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page.keyboard.press("p");
      await wait(900);
    },
  },
  "graph-focus": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page
        .locator(".vue-flow__node-k8s")
        .filter({ hasText: "checkout-api" })
        .filter({ has: page.locator(".graph-card__meta", { hasText: "Deployment" }) })
        .first()
        .dblclick();
      await page.mouse.move(5, 500);
      await wait(1200);
    },
  },
  "graph-large": { url: "/cluster-overview?scenario=large-graph", ready: ".vue-flow__node-k8s", settle: 3000 },
  // Zoomed out: cards drawn on the canvas (names + health), then the overview.
  "graph-zoomed-out": {
    url: "/cluster-overview?scenario=large-graph",
    ready: ".vue-flow__node-k8s",
    settle: 2500,
    run: async (page) => {
      await wheelZoom(page, 14);
      await wait(900);
    },
  },
  "graph-overview": {
    url: "/cluster-overview?scenario=large-graph",
    ready: ".vue-flow__node-k8s",
    settle: 2500,
    run: async (page) => {
      await wheelZoom(page, 30);
      await wait(900);
    },
  },
  "graph-search": {
    url: "/cluster-overview?scenario=large-graph",
    ready: ".vue-flow__node-k8s",
    settle: 2500,
    run: async (page) => {
      await page.getByLabel("Find an object").fill("orders");
      await wait(700);
    },
  },
  // Node placement: pods grouped by the node they run on.
  "graph-placement": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page.keyboard.press("n");
      await wait(1200);
    },
  },
  // A live change: the selected workload loses its replicas, a pod appears.
  "graph-live": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page.keyboard.press("ArrowRight");
      await wait(300);
      await page.evaluate(() =>
        window.__harnessMutate("deployments", "nginx", (d) => ({
          ...d,
          status: { ...d.status, availableReplicas: 0, readyReplicas: 0 },
        }))
      );
      await page.mouse.move(5, 500);
      await wait(1200);
    },
  },
  yaml: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Edit");
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(1500);
    },
  },
  logs: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs", "All containers");
      await wait(2000);
    },
  },
  terminal: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Shell", null);
      await wait(1500);
    },
  },
  describe: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await wait(1500);
    },
  },
  events: { url: "/events?resource=events&kind=Event", ready: "tbody tr td" },
  nodes: { url: "/nodes?resource=nodes&kind=Node", ready: "tbody tr td" },
  // Operators and CRDs (dev/harness/operators.ts).
  // The sidebar from Helm down: every CRD group (a tall window, the sidebar only).
  "nav-crds": {
    url: "/certificates?resource=certificates&kind=Certificate",
    ready: "tbody tr td",
    viewport: { width: 1440, height: 2380 },
    clip: { x: 0, y: 0, width: 228, height: 2380 },
    run: async (page) => {
      await page.locator("nav button", { hasText: /^\s*Helm\s*$/ }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
      await wait(500);
    },
  },
  // The long tail of unknown groups, opened.
  "nav-more": {
    url: "/certificates?resource=certificates&kind=Certificate",
    ready: "tbody tr td",
    clip: { x: 0, y: 0, width: 228, height: 900 },
    run: async (page) => {
      const more = page.locator("nav button", { hasText: "More resources" }).first();
      await more.click();
      await more.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await wait(500);
    },
  },
  "crd-printer-columns": { url: "/backups?resource=backups&kind=Backup", ready: "tbody tr td", settle: 1500 },
  certificates: { url: "/certificates?resource=certificates&kind=Certificate", ready: "tbody tr td" },
  "certificate-panel": {
    url: "/certificates?resource=certificates&kind=Certificate",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-tls" }).first().click();
      await wait(1500);
    },
  },
  challenges: { url: "/challenges?resource=challenges&kind=Challenge", ready: "tbody tr td" },
  "httproute-panel": {
    url: "/httproutes?resource=httproutes&kind=HTTPRoute",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout" }).first().click();
      await wait(1500);
    },
  },
  "gateway-panel": {
    url: "/gateways?resource=gateways&kind=Gateway",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "public-gateway" }).first().click();
      await wait(1500);
    },
  },
  nodepools: { url: "/nodepools?resource=nodepools&kind=NodePool", ready: "tbody tr td" },
  nodeclaims: { url: "/nodeclaims?resource=nodeclaims&kind=NodeClaim", ready: "tbody tr td" },
  "nodepool-panel": {
    url: "/nodepools?resource=nodepools&kind=NodePool",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "general-purpose" }).first().click();
      await wait(1500);
    },
  },
  scaledobjects: { url: "/scaledobjects?resource=scaledobjects&kind=ScaledObject", ready: "tbody tr td" },
  "scaledobject-panel": {
    url: "/scaledobjects?resource=scaledobjects&kind=ScaledObject",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).first().click();
      await wait(1500);
    },
  },
  externalsecrets: { url: "/externalsecrets?resource=externalsecrets&kind=ExternalSecret", ready: "tbody tr td" },
  "externalsecret-panel": {
    url: "/externalsecrets?resource=externalsecrets&kind=ExternalSecret",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "ledger-signing-key" }).first().click();
      await wait(1500);
    },
  },
  "row-menu": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).nth(1).click({ button: "right" });
      await wait(500);
    },
  },
  selection: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      for (const i of [1, 2, 4]) {
        await page.locator("tbody tr").nth(i).hover();
        await page.locator("tbody tr").nth(i).locator('[role="checkbox"]').click();
      }
      await wait(500);
    },
  },
  "port-forwards": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openForwards(page);
    },
  },
  // Port forwards (dev/harness/portForwards.ts): the manager, a forward
  // healing itself, named ports, the HTTP tester and saved profiles.
  "pf-manager": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openForwards(page);
      await page.locator("[data-forward-id]").first().hover();
      await wait(400);
    },
  },
  "pf-reconnecting": {
    url: "/pods?pf=reconnecting",
    ready: "tbody tr td",
    run: async (page) => {
      await openForwards(page);
    },
  },
  "pf-dialog-named-ports": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Port Forward");
      await wait(700);
      await page.getByRole("combobox", { name: "Port" }).click();
      await wait(500);
    },
  },
  "pf-http-tester": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openForwards(page);
      const row = page.locator("[data-forward-id]").first();
      await row.hover();
      await row.getByRole("button", { name: /Send a request/ }).click();
      await wait(500);
      const path = page.getByRole("textbox", { name: "Path" });
      for (const value of ["/healthz", "/metrics", "/api/orders?limit=2"]) {
        await path.fill(value);
        await path.press("Enter");
        await wait(450);
      }
      await page.getByRole("button", { name: /Headers · / }).click();
      await wait(400);
    },
  },
  "workspace-rename": {
    url: "/pods?fresh=1",
    ready: "tbody tr td",
    run: async (page) => {
      const switcher = page.locator("[data-workspace-switcher]");
      await switcher.click();
      await page.locator('[role="menuitem"]', { hasText: "Save current as new workspace" }).click();
      await wait(400);
      await switcher.click();
      await page.locator('[role="menuitem"]', { hasText: "Rename" }).click();
      await wait(700);
    },
  },
  "pf-profiles": {
    url: "/pods?pf=profiles",
    ready: "tbody tr td",
    settle: 1800,
    run: async (page) => {
      await openForwards(page);
    },
  },
  macos: { url: "/deployments?resource=deployments&kind=Deployment&os=macos", ready: "tbody tr td" },
  settings: { url: "/settings/general", ready: "main, form, h1, h2", settle: 1200 },
  "settings-appearance": { url: "/settings/appearance", ready: "body", settle: 1200 },
  "settings-terminal": { url: "/settings/terminal", ready: "main h2", settle: 1000 },
  "settings-tables": { url: "/settings/tables", ready: "main h2", settle: 1000 },
  "settings-clusters": {
    url: "/settings/clusters?scenario=kubeconfigs",
    ready: "main h2",
    settle: 1500,
    run: async (page) => {
      await page.getByRole("button", { name: /Show the contexts of .*\/\.kube\/config$/ }).first().click();
      await wait(600);
    },
  },
  "settings-advanced": { url: "/settings/advanced?scenario=tools-missing", ready: "main h2", settle: 1500 },
  "settings-search": {
    url: "/settings/general",
    ready: "main h2",
    run: async (page) => {
      await page.getByLabel("Search settings").fill("font");
      await wait(500);
    },
  },
  "settings-json": { url: "/settings/json?key=terminal.fontSize", ready: ".monaco-editor", settle: 1800 },
  "clusters-hub": { url: "/clusters?scenario=hub", ready: "[role=grid]", settle: 3500 },
  "clusters-embedded": { url: "/pods?scenario=nocontext", ready: "[role=grid]", settle: 2000 },
  // Per-cluster connections (dev/harness/desktop.ts): an SSH jump host that
  // is up, one that fails, a SOCKS proxy, and a proxy-url in the kubeconfig.
  "connection-detail": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 2500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "Payments prod" }).first().click();
      await wait(1200);
    },
  },
  "connection-failed": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 2500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "Payments DR" }).first().click();
      await wait(1200);
    },
  },
  "connection-kubeconfig-proxy": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 2500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "Checkout" }).first().click();
      await wait(1200);
    },
  },
  "connection-edit-ssh": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 2500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "Payments DR" }).first().click();
      await wait(900);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await wait(900);
      await page.locator("#cluster-ssh-jump").scrollIntoViewIfNeeded();
      await wait(400);
    },
  },
  "connection-edit-proxy": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 2500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "Sandbox" }).first().click();
      await wait(900);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await wait(900);
      await page.getByRole("tab", { name: "Proxy" }).click();
      await page.locator("#cluster-proxy").fill("proxy.corp.example:3128");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await wait(500);
    },
  },
  // jetpilot:// links (?link= is handed over like the link the app started with).
  "deep-link-open": {
    url: `/pods?link=${encodeURIComponent("jetpilot://open?context=prod-eu-west-1&kind=Deployment&apiVersion=apps/v1&namespace=payments&name=payments-api")}`,
    ready: "[role=grid], table",
    settle: 3500,
  },
  "deep-link-helm": {
    url: `/pods?link=${encodeURIComponent("jetpilot://helm?context=prod-eu-west-1&namespace=checkout&name=checkout")}`,
    ready: "[role=grid], table",
    settle: 3500,
  },
  "deep-link-list": {
    url: `/pods?link=${encodeURIComponent("jetpilot://list?context=staging-us-east-2&kind=StatefulSet&apiVersion=apps/v1")}`,
    ready: "[role=grid], table",
    settle: 3500,
  },
  "deep-link-unknown": {
    url: `/pods?link=${encodeURIComponent("jetpilot://open?context=prod-us-east-1&kind=Deployment&apiVersion=apps/v1&namespace=shop&name=checkout-api")}`,
    ready: "[role=grid], table",
    settle: 3000,
  },
  "deep-link-palette": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    settle: 1200,
    run: async (page) => {
      await page.keyboard.press("Control+k");
      await wait(500);
      await page.keyboard.type("link");
      await wait(600);
    },
  },
  "deep-link-row-menu": {
    url: "/pods",
    ready: "tbody tr",
    settle: 1500,
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click({ button: "right" });
      await wait(500);
      await page.locator('[role="menuitem"]', { hasText: "Copy link" }).hover();
      await wait(300);
    },
  },
  "deep-link-panel-menu": {
    url: "/pods",
    ready: "tbody tr",
    settle: 1500,
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await wait(1500);
      await page.getByRole("button", { name: "More", exact: true }).click();
      await wait(500);
    },
  },
  // GitOps (dev/harness/gitops.ts): both contexts, Flux and Argo CD.
  gitops: { url: "/gitops?contexts=2", ready: "[data-delivery-key]", settle: 1500 },
  "gitops-panel": {
    url: "/gitops",
    ready: "[data-delivery-key]",
    settle: 1200,
    run: async (page) => {
      await page.locator("[data-delivery-key]", { hasText: "payments" }).first().click();
      await wait(1500);
    },
  },
  "gitops-argo-panel": {
    url: "/gitops",
    ready: "[data-delivery-key]",
    settle: 1200,
    run: async (page) => {
      await page.locator("[data-delivery-key]", { hasText: "checkout-web" }).first().click();
      await wait(1500);
    },
  },
  "gitops-empty": { url: "/gitops?scenario=no-gitops", ready: "main, h1", settle: 2500 },
  "setup-guide": { url: "/pods?scenario=fresh", ready: "[aria-label='Set up JET Pilot']", settle: 1500 },
  empty: { url: "/pods?scenario=empty", ready: "table", settle: 1500 },
  error: { url: "/pods?scenario=error", ready: "[role=alert]", settle: 800 },
  "no-context": { url: "/pods?scenario=nocontext", ready: "body", settle: 1500 },
  "port-forward-dialog": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Port Forward");
      await wait(900);
    },
  },
  "workload-logs": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs", "All pods");
      await enlargePanel(page);
      await wait(2500);
    },
  },
  "workload-logs-search": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs", "All pods");
      await enlargePanel(page);
      await wait(1500);
      await page.getByRole("button", { name: "Pause view" }).click();
      await page.getByLabel("Search logs").fill("charge");
      await page.getByLabel("Search logs").press("Enter");
      await page.getByLabel("Search logs").press("Enter");
      await wait(600);
    },
  },
  "rollout-history": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Rollout history");
      await enlargePanel(page);
      await wait(1500);
    },
  },
  "rollback-confirm": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Rollout history");
      await enlargePanel(page);
      await wait(1200);
      await page.getByRole("button", { name: /Roll back to r/ }).click();
      await wait(600);
    },
  },
  "helm-upgrade": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Upgrade");
      await enlargePanel(page);
      await wait(1200);
      const values = await page.locator("textarea").inputValue();
      await page.locator("textarea").fill(
        values.replace("tag: v2.14.3", "tag: v2.15.0").replace("replicaCount: 4", "replicaCount: 6") + "fastRefunds: true\n"
      );
      await page.getByRole("button", { name: "Preview changes" }).click();
      await wait(1200);
    },
  },
  "helm-values-diff": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Upgrade");
      await enlargePanel(page);
      await wait(1200);
      const values = await page.locator("textarea").inputValue();
      await page.locator("textarea").fill(values.replace("tag: v2.14.3", "tag: v2.15.0"));
      await page.getByRole("tab", { name: /Values diff/ }).click();
      // Monaco loads lazily and diffs in a worker.
      await wait(2000);
    },
  },
  "helm-history": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "History");
      await enlargePanel(page);
      await wait(1500);
    },
  },
  /* --------------------------------------------------------- helm -- */
  "helm-releases": { url: "/helm-releases?resource=release&kind=Release", ready: "tbody tr td", settle: 1200 },
  "helm-release-panel": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await page.waitForSelector("text=Resources", { timeout: 8000 }).catch(() => {});
      await wait(1500);
    },
  },
  "helm-release-failed": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout" }).first().click();
      await page.waitForSelector("text=Resources", { timeout: 8000 }).catch(() => {});
      await wait(1500);
    },
  },
  "helm-release-history": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await page.waitForSelector("[aria-label=Revisions] button", { timeout: 8000 }).catch(() => {});
      await page.getByRole("button", { name: /^Notes/ }).click().catch(() => {});
      await page.getByRole("button", { name: /^Resources/ }).click().catch(() => {});
      await page.getByRole("button", { name: /^Values/ }).click().catch(() => {});
      await wait(300);
      const revisions = page.locator("[aria-label=Revisions] button");
      await revisions.nth(0).click();
      await revisions.nth(2).click();
      await wait(600);
    },
  },
  "helm-release-values": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await page.waitForSelector("[aria-label=Revisions] button", { timeout: 8000 }).catch(() => {});
      await page.getByRole("button", { name: /^Notes/ }).click().catch(() => {});
      await page.getByRole("button", { name: /^Resources/ }).click().catch(() => {});
      await page.getByRole("button", { name: /^History/ }).click().catch(() => {});
      await wait(500);
    },
  },
  "helm-release-pending": {
    url: "/helm-releases?resource=release&kind=Release",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "feature-flags" }).first().click();
      await page.waitForSelector("text=Resources", { timeout: 8000 }).catch(() => {});
      await wait(1500);
    },
  },
  "helm-releases-empty": { url: "/helm-releases?resource=release&kind=Release&scenario=empty", ready: "table", settle: 1500 },
  "helm-install-hub": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByLabel("Search charts").fill("argo");
      await page.waitForSelector("[data-chart]", { timeout: 8000 }).catch(() => {});
      await wait(1200);
      await page.locator("[data-chart]", { hasText: "argo-cd" }).first().click();
      await wait(700);
      await enlargePanel(page, -420);
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(800);
      await page.getByRole("button", { name: /^Preview/ }).click();
      await wait(800);
    },
  },
  "helm-charts-search": {
    url: "/helm-charts",
    ready: "main, h1",
    run: async (page) => {
      await page.getByLabel("Search charts").fill("redis");
      await page.waitForSelector("text=Artifact Hub", { timeout: 8000 }).catch(() => {});
      await wait(1500);
    },
  },
  "helm-charts": { url: "/helm-charts", ready: "h1", settle: 1500 },
  "helm-install": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByLabel("Search charts").fill("redis");
      await wait(1200);
      await page.locator("[data-chart]", { hasText: "redis" }).first().click();
      await wait(700);
      await enlargePanel(page, -420);
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(1500);
    },
  },
  "helm-install-preview": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByLabel("Search charts").fill("redis");
      await wait(1200);
      await page.locator("[data-chart]", { hasText: "redis" }).first().click();
      await wait(700);
      await enlargePanel(page, -420);
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(800);
      await page.getByRole("button", { name: /^Preview/ }).click();
      await page.waitForSelector("text=objects", { timeout: 10000 }).catch(() => {});
      await wait(1200);
    },
  },
  "helm-install-done": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByLabel("Search charts").fill("redis");
      await wait(1200);
      await page.locator("[data-chart]", { hasText: "redis" }).first().click();
      await wait(700);
      await enlargePanel(page, -420);
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(800);
      await page.getByRole("button", { name: /^Preview/ }).click();
      await page.waitForSelector("text=objects", { timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: /^Install/ }).last().click();
      await wait(600);
      await page.getByRole("button", { name: /^Install$/ }).last().click().catch(() => {});
      await page.waitForSelector("text=Installed", { timeout: 10000 }).catch(() => {});
      await wait(1000);
    },
  },
  "helm-repos": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByRole("tab", { name: /Repositories/ }).click();
      await wait(900);
    },
  },
  "helm-repo-add": {
    url: "/helm-charts",
    ready: "h1",
    run: async (page) => {
      await page.getByRole("tab", { name: /Repositories/ }).click();
      await wait(600);
      await page.getByRole("button", { name: /Add repository/ }).first().click();
      await wait(300);
      await page.locator("#helm-repo-name").fill("bitnami");
      await page.locator("#helm-repo-url").fill("grafana.github.io/helm-charts");
      await page.locator("#helm-repo-url").blur();
      await wait(500);
    },
  },
  "helm-charts-norepos": { url: "/helm-charts?scenario=helm-norepos", ready: "h1", settle: 1500 },
  "debug-dialog": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Debug");
      await wait(900);
    },
  },
  "debug-shell": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Debug");
      await wait(600);
      await page.getByRole("button", { name: "Start debugging" }).click();
      await enlargePanel(page);
      await wait(1200);
    },
  },
  "node-shell": {
    url: "/nodes?resource=nodes&kind=Node",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "ip-10-0-12-34", "Node shell");
      await wait(900);
    },
  },
  "copy-files": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Copy files");
      await page.locator("#copy-remote").fill("/var/log/app/payments.log");
      await page.getByRole("button", { name: /Browse/ }).click();
      await wait(600);
    },
  },
  "delete-dialog": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "checkout-api", "Kill");
      await wait(900);
    },
  },
  /* ----------------------------------------------- editor (G4) -- */
  "editor-schema": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await editYaml(page, "^  replicas: (.*)$", "  replicas: $1\n  re");
      await cursorAt(page, "^  re$", "end");
      await wait(1500);
      await editorTrigger(page, "editor.action.triggerSuggest");
      await wait(1500);
    },
  },
  "editor-hover": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await cursorAt(page, "^  strategy:", 3);
      await editorTrigger(page, "editor.action.showHover");
      await wait(1500);
    },
  },
  review: {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: 6");
      await editYaml(page, "^(\\s+)image: (.*):v2.14.3$", "$1image: $2:v2.15.0");
      await page.keyboard.press("Control+s");
      await page.waitForFunction(() => /passed/.test(document.querySelector("[data-testid=dry-run-status]")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-errors": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: -1");
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=problems]", { timeout: 15000 }).catch(() => {});
      await editYaml(page, "^(\\s+)imagePullPolicyy: Always\n", "");
      await page.keyboard.press("Control+s");
      await page.waitForFunction(() => /Rejected/.test(document.querySelector("[data-testid=dry-run-status]")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-strict": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=problems]", { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-conflict": {
    url: "/deployments?resource=deployments&kind=Deployment&scenario=conflict",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: 6");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=conflict]", { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "describe-search": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await page.waitForSelector("[data-testid=describe-output]", { timeout: 10000 }).catch(() => {});
      await page.keyboard.press("Control+f");
      await page.keyboard.type("ready");
      await page.keyboard.press("Enter");
      await wait(800);
    },
  },
  "describe-yaml": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await page.waitForSelector("[data-testid=describe-output]", { timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: "YAML", exact: true }).click();
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(1500);
    },
  },
  compare: {
    url: "/deployments?resource=deployments&kind=Deployment&scenario=compare",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await page.getByRole("button", { name: /Compare/ }).click();
      await wait(400);
      await page.locator('[role="menuitem"]', { hasText: "staging-us-east-2" }).first().click();
      await page.waitForSelector(".monaco-diff-editor", { timeout: 20000 }).catch(() => {});
      await wait(2000);
    },
  },
  /* ------------------------------------------- usage charts (metrics.ts) -- */
  "metrics-pod": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "OOMKilled" }).first());
      await hoverChart(page, 1, 0.93);
    },
  },
  "metrics-deployment": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "payments-api" }).first());
      await hoverChart(page, 0, 0.87);
    },
  },
  "metrics-deployment-pods": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "payments-worker" }).first());
      await page.getByRole("switch", { name: "Per pod" }).click();
      await hoverChart(page, 1, 0.6);
    },
  },
  "metrics-node": {
    url: "/nodes?resource=nodes&kind=Node",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "ip-10-0-45-118" }).first());
      await page.getByRole("tab", { name: "24h" }).click();
      await wait(900);
    },
  },
  "metrics-fallback": {
    url: "/pods?scenario=metrics-none",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "payments-api" }).first());
      await hoverChart(page, 0, 0.7);
    },
  },
  "metrics-error": {
    url: "/pods?scenario=metrics-error",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "payments-api" }).first());
      await page.getByRole("button", { name: "Details" }).click();
      await wait(300);
    },
  },
  "metrics-cluster": {
    url: "/clusters",
    ready: "[role=grid]",
    settle: 1500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "prod-eu-west-1" }).first().click();
      await wait(1200);
    },
  },
  "metrics-namespace": {
    url: "/namespaces?resource=namespaces&kind=Namespace",
    ready: "tbody tr td",
    run: async (page) => {
      await openUsage(page, page.locator("tbody tr", { hasText: "checkout" }).first());
      await page.getByRole("tab", { name: "7d" }).click();
      await wait(900);
    },
  },
  // Custom actions (dev/harness/actions.ts): files in the actions folder, one broken.
  "actions-settings": { url: "/settings/actions", ready: "[aria-label='Your actions']", settle: 1200 },
  "actions-empty": { url: "/settings/actions?scenario=no-actions", ready: "[aria-label='Example actions']", settle: 1200 },
  "actions-editor": {
    url: "/settings/actions/edit/logs-since.yaml",
    ready: "#action-name",
    settle: 1000,
    run: async (page) => {
      await page.locator("main").evaluate((main) => main.closest("[data-settings-scroll]")?.scrollTo({ top: 330 }));
      await wait(400);
    },
  },
  "actions-yaml": {
    url: "/settings/actions/yaml/restart-deployment.yaml",
    ready: ".monaco-editor",
    settle: 1800,
    run: async (page) => {
      await cursorAt(page, "kubectl:", 5);
      await editorTrigger(page, "editor.action.showHover");
      await wait(1200);
    },
  },
  "actions-error": { url: "/settings/actions/yaml/preview-environment.yaml", ready: ".monaco-editor", settle: 1800 },
  "actions-row-menu": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click({ button: "right" });
      await wait(600);
    },
  },
  "actions-palette": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await wait(800);
      await page.keyboard.press("Control+k");
      await wait(400);
      await page.keyboard.type("run");
      await wait(600);
    },
  },
  "actions-input-prompt": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs since");
      await wait(700);
    },
  },
  "actions-panel": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-api" }).first().click();
      await wait(1200);
    },
  },
  "metrics-settings": {
    url: "/clusters",
    ready: "[role=grid]",
    settle: 1500,
    run: async (page) => {
      await page.locator("[role=grid] [role=row]", { hasText: "prod-eu-west-1" }).first().click();
      await wait(1200);
      await page.getByRole("button", { name: "Change metrics history" }).click();
      await wait(900);
      await page.getByRole("radio", { name: /A service I choose/ }).click();
      await page.mouse.move(5, 5);
      await wait(500);
    },
  },
  // Access review (dev/harness/rbac.ts): you are maria@acme.dev.
  "access-can-i": {
    url: "/access-review?verb=delete&resource=deployments.apps&namespace=payments",
    ready: "text=you can",
    settle: 1200,
    run: openAccessControl,
  },
  "access-can-i-denied": {
    url: "/access-review?verb=get&resource=secrets&namespace=kube-system",
    ready: "text=you can't",
    settle: 1200,
  },
  "access-who-can": {
    url: "/access-review?tab=who&verb=delete&resource=deployments.apps&namespace=@all",
    ready: "text=subjects can",
    settle: 1000,
    run: openAccessControl,
  },
  "access-subject": {
    url: "/access-review?tab=subjects&subject=ServiceAccount:payments:payments-api",
    ready: "text=How it gets access",
    settle: 1200,
  },
  "access-role-panel": {
    url: "/clusterroles?resource=clusterroles&kind=ClusterRole",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr td").filter({ hasText: /^\s*admin\s*$/ }).first().click();
      await wait(2500);
    },
  },
  "access-binding-panel": {
    url: "/rolebindings?resource=rolebindings&kind=RoleBinding",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "payments-team-admin" }).first().click();
      await wait(2500);
    },
  },
  "access-sa-panel": {
    url: "/serviceaccounts?resource=serviceaccounts&kind=ServiceAccount",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "ci-deployer" }).first().click();
      await wait(2500);
    },
  },
  "access-forbidden": {
    url: "/access-review?tab=who&scenario=rbac-forbidden",
    ready: "text=can't read this cluster's RBAC",
    settle: 1000,
  },
  /* ------------------------------------------ side panels (panels.ts) -- */
  "panel-pod": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "checkout-api" }).nth(1));
    },
  },
  "panel-node": {
    url: "/nodes?resource=nodes&kind=Node",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "ip-10-0-78-201" }).first());
    },
  },
  "panel-node-taints-edit": {
    url: "/nodes?resource=nodes&kind=Node",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "ip-10-0-45-118" }).first(), { foldUsage: true });
      await page.getByRole("button", { name: "Edit taints" }).click();
      await page.getByRole("button", { name: "Add taint" }).click();
      await page.keyboard.type("dedicated");
      await page.getByRole("textbox", { name: /Value of dedicated/ }).fill("payments");
      await page.getByRole("combobox", { name: /Effect of dedicated/ }).click();
      await wait(300);
      await page.getByRole("option", { name: /NoExecute/ }).click();
      await scrollPanelTo(page, "Taints");
      await wait(500);
    },
  },
  "panel-service": {
    url: "/services?resource=services&kind=Service",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "checkout-api" }).first());
    },
  },
  "panel-ingress": {
    url: "/ingresses?resource=ingresses&kind=Ingress",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "checkout" }).first());
    },
  },
  "panel-pvc": {
    url: "/persistentvolumeclaims?resource=persistentvolumeclaims&kind=PersistentVolumeClaim",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "data-postgres-0" }).first());
    },
  },
  "panel-pvc-pending": {
    url: "/persistentvolumeclaims?resource=persistentvolumeclaims&kind=PersistentVolumeClaim",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "data-redis-0" }).first());
    },
  },
  "panel-hpa": {
    url: "/horizontalpodautoscalers?resource=horizontalpodautoscalers&kind=HorizontalPodAutoscaler",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "payments-api" }).first());
    },
  },
  "panel-hpa-max": {
    url: "/horizontalpodautoscalers?resource=horizontalpodautoscalers&kind=HorizontalPodAutoscaler",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "checkout-web" }).first());
    },
  },
  "panel-cronjob": {
    url: "/cronjobs?resource=cronjobs&kind=CronJob",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "db-backup" }).first());
    },
  },
  "panel-configmap": {
    url: "/configmaps?resource=configmaps&kind=ConfigMap",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "payments-config" }).first());
    },
  },
  "panel-namespace": {
    url: "/namespaces?resource=namespaces&kind=Namespace",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "payments" }).first());
    },
  },
  "panel-deployment": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "checkout-api" }).first());
    },
  },
  "panel-statefulset": {
    url: "/statefulsets?resource=statefulsets&kind=StatefulSet",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "postgres" }).first(), { foldUsage: true });
    },
  },
  "panel-daemonset": {
    url: "/daemonsets?resource=daemonsets&kind=DaemonSet",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "node-exporter" }).first(), { foldUsage: true });
    },
  },
  "panel-job": {
    url: "/jobs?resource=jobs&kind=Job",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "report-generator" }).first(), { foldUsage: true });
    },
  },
  "panel-pv": {
    url: "/persistentvolumes?resource=persistentvolumes&kind=PersistentVolume",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr").first());
    },
  },
  "panel-storageclass": {
    url: "/storageclasses?resource=storageclasses&kind=StorageClass",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "gp3" }).first());
    },
  },
  "panel-event": {
    url: "/events?resource=events&kind=Event",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "Back-off restarting" }).first());
    },
  },
  "panel-labels-edit": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "payments-api" }).first(), { foldUsage: true });
      await page.getByRole("button", { name: "Edit labels" }).click();
      await page.getByRole("textbox", { name: "Value of tier" }).fill("api");
      await page.getByRole("button", { name: "Remove app.kubernetes.io/version" }).click();
      await page.getByRole("button", { name: "Add label" }).click();
      await page.keyboard.type("team");
      await page.getByRole("textbox", { name: "Value of team" }).fill("payments");
      await page.getByRole("button", { name: "Add label" }).click();
      await page.keyboard.type("Cost Center");
      await scrollPanelTo(page, "Labels");
      await wait(500);
    },
  },
  "panel-labels-error": {
    url: "/deployments?resource=deployments&kind=Deployment&scenario=edit-forbidden",
    ready: "tbody tr td",
    run: async (page) => {
      await openPanel(page, page.locator("tbody tr", { hasText: "payments-api" }).first(), { foldUsage: true });
      await page.getByRole("button", { name: "Edit labels" }).click();
      await page.getByRole("button", { name: "Add label" }).click();
      await page.keyboard.type("team");
      await page.getByRole("textbox", { name: "Value of team" }).fill("payments");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await wait(600);
      await scrollPanelTo(page, "Labels");
      await wait(400);
    },
  },
  "panel-follow": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.getByPlaceholder("Filter pods…").fill("postgres-0");
      await wait(400);
      await openPanel(page, page.locator("tbody tr", { hasText: "postgres-0" }).first(), { foldUsage: true });
      await page.getByRole("button", { name: "data-postgres-0", exact: true }).click();
      await wait(1200);
    },
  },
  "describe-native": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "CrashLoopBackOff", "Describe");
      await page.waitForSelector("[data-testid=describe-native]", { timeout: 10000 }).catch(() => {});
      await enlargePanel(page);
      await wait(1000);
    },
  },
  "describe-kubectl": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await page.waitForSelector("[data-testid=describe-native]", { timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: "kubectl describe", exact: true }).click();
      await page.waitForSelector("[data-testid=describe-output]", { timeout: 10000 }).catch(() => {});
      await wait(800);
    },
  },
  "describe-native-search": {
    url: "/nodes?resource=nodes&kind=Node",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "ip-10-0-78-201", "Describe");
      await page.waitForSelector("[data-testid=describe-native]", { timeout: 10000 }).catch(() => {});
      await enlargePanel(page);
      await page.keyboard.press("Control+f");
      await page.keyboard.type("pressure");
      await page.keyboard.press("Enter");
      await wait(800);
    },
  },
};

/*
 * Opens a row's side panel, widened; `foldUsage` folds the usage charts so
 * the kind's own sections show.
 */
async function openPanel(page, row, { foldUsage = false } = {}) {
  await row.click();
  await wait(600);
  const handles = page.locator("[data-panel-resize-handle-id]");
  for (let i = 0; i < (await handles.count()); i++) {
    const box = await handles.nth(i).boundingBox();
    if (!box || box.height < box.width || box.x < 600) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 130, box.y + 200, { steps: 8 });
    await page.mouse.up();
    break;
  }
  if (foldUsage) {
    const usage = page.locator("[data-keyboard-scope=side-panel] h3 button", { hasText: /^\s*Usage\s*$/ }).first();
    if (await usage.count()) await usage.click();
  }
  await page.mouse.move(5, 500);
  await wait(1200);
}

/* Scrolls the side panel so a section heading is near its top. */
async function scrollPanelTo(page, title) {
  await page.evaluate((title) => {
    const panel = document.querySelector("[data-keyboard-scope=side-panel]");
    const heading = [...(panel?.querySelectorAll("h3 button") ?? [])].find((b) => b.textContent?.trim().startsWith(title));
    if (panel && heading) panel.scrollTop += heading.getBoundingClientRect().top - panel.getBoundingClientRect().top - 150;
  }, title);
}

/* Opens the sidebar's Access Control group (collapsed in the fixture settings). */
async function openAccessControl(page) {
  await page.locator("nav button", { hasText: /^Access control$/i }).first().click().catch(() => {});
  await page.mouse.move(700, 880);
  await wait(400);
}

/* Opens a row's side panel, widened, with the usage charts loaded. */
async function openUsage(page, row) {
  await row.click();
  await page.waitForSelector("[aria-label='Loading usage']", { state: "detached", timeout: 10000 }).catch(() => {});
  const handles = page.locator("[data-panel-resize-handle-id]");
  for (let i = 0; i < (await handles.count()); i++) {
    const box = await handles.nth(i).boundingBox();
    if (!box || box.height < box.width || box.x < 600) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 200, { steps: 8 });
    await page.mouse.up();
    break;
  }
  await wait(1200);
}

/* Hovers the n-th usage chart at a fraction of its width. */
async function hoverChart(page, n, at) {
  const chart = page.locator("svg[role=img][tabindex='0']").nth(n);
  const box = await chart.boundingBox().catch(() => null);
  if (!box) return;
  await page.mouse.move(box.x + (box.width - 46) * at, box.y + box.height * 0.4);
  await wait(400);
}

/* Editor helpers: drive Monaco through window.monaco (harness globalAPI). */
async function openEditor(page, rowText = "payments-api") {
  await openRowAction(page, rowText, "Edit");
  await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
  await page
    .waitForFunction(() => /·/.test(document.querySelector("[data-testid=schema-status]")?.textContent || ""), null, { timeout: 20000 })
    .catch(() => console.error("schema did not load"));
  await wait(800);
}

async function editYaml(page, search, replace) {
  await page.evaluate(
    ({ search, replace }) => {
      const model = monaco.editor.getModels().find((m) => m.uri.authority === "jet-pilot");
      const text = model.getValue().replace(new RegExp(search, "m"), replace);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      const editor = monaco.editor.getEditors().find((e) => e.getModel() === model && e.getContainerDomNode().offsetParent);
      editor?.focus();
    },
    { search, replace }
  );
  await wait(300);
}

async function cursorAt(page, search, column) {
  await page.evaluate(
    ({ search, column }) => {
      const model = monaco.editor.getModels().find((m) => m.uri.authority === "jet-pilot");
      const [match] = model.findMatches(search, false, true, true, null, false);
      const line = match.range.startLineNumber;
      const editor = monaco.editor.getEditors().find((e) => e.getModel() === model && e.getContainerDomNode().offsetParent);
      editor.setPosition({ lineNumber: line, column: column === "end" ? model.getLineMaxColumn(line) : column });
      editor.revealLineInCenter(line);
      editor.focus();
    },
    { search, column }
  );
}

async function editorTrigger(page, action) {
  await page.evaluate((action) => {
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
    editor?.trigger("shoot", action, {});
  }, action);
}

/* Drags the bottom panel up so tab content gets most of the window. */
/* Wheel-zooms out (positive steps) around the centre of the graph. */
async function wheelZoom(page, steps) {
  const box = await page.locator(".vue-flow").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.mouse.wheel(0, Math.sign(steps) * 40);
    await wait(30);
  }
}

async function enlargePanel(page, dy = -330) {
  const handle = page.locator("[data-panel-resize-handle-id]").first();
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  await wait(300);
}

async function openForwards(page) {
  await page.getByRole("button", { name: /^Port forwards:/ }).click();
  await wait(700);
}

async function openRowAction(page, rowText, action, sub) {
  const row = page.locator("tbody tr", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await wait(300);
  const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^\\s*${action}\\b`) }).first();
  if (sub !== undefined) {
    await item.hover();
    await wait(300);
    const subItem = sub
      ? page.locator('[role="menuitem"]', { hasText: sub }).first()
      : page.locator('[role="menu"]').last().locator('[role="menuitem"]').first();
    await subItem.click();
  } else {
    await item.click();
  }
  await wait(500);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--font-render-hinting=none", "--disable-gpu"],
});

const results = [];
const themeIds = (process.env.THEMES || "").split(",").filter(Boolean);
for (const themeId of themeIds.length ? themeIds : [null])
for (const theme of ["dark", "light"]) {
  for (const [name, screen] of Object.entries(screens)) {
    if (only.length && !only.includes(name)) continue;
    const context = await browser.newContext({
      viewport: screen.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${name}/${theme}] pageerror`, e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`[${name}/${theme}] console`, m.text());
    });
    const scenario = new URL(BASE + screen.url).searchParams.get("scenario") || "default";
    const sep = screen.url.includes("?") ? "&" : "?";
    try {
      const os = new URL(BASE + screen.url).searchParams.get("os") || "linux";
      const themeParam = themeId ? `&themeId=${themeId}` : "";
      await page.goto(`${BASE}${screen.url}${sep}theme=${theme}&scenario=${scenario}&os=${os}${themeParam}`);
      await page.waitForSelector(screen.ready, { timeout: 15000 }).catch(() => {
        console.error(`[${name}/${theme}] ready selector timed out: ${screen.ready}`);
      });
      await wait(screen.settle ?? 900);
      if (screen.run) await screen.run(page);
      const file = `${OUT}/${prefix}-${name}-${theme}${themeId ? `-${themeId}` : ""}.png`;
      await page.screenshot({ path: file, clip: screen.clip });
      results.push(file);
    } catch (e) {
      console.error(`[${name}/${theme}] failed`, e.message);
    }
    await context.close();
  }
}
await browser.close();
console.log(results.join("\n"));
